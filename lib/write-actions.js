/**
 * The only write path in the plugin.
 *
 * Every operation is one official Dataverse unbound action —
 * `InsertOptionValue`, `UpdateOptionValue` — and nothing else. A plan is built
 * read-only, shown to a person in the settings page, and executed only by that
 * person's confirmation. Results are appended to the change ledger.
 */
import { DataverseClient } from './client.js'
import { getPagedWithSelectFallback } from './client.js'
import { D365Error } from './errors.js'
import { busyError, checkEnvironmentIdle } from './preflight.js'
import { allows, readPolicy } from './write-policy.js'
import { createPlan, recordChange, setPlanStatus, writePublishReport } from './write-store.js'
import { COMPONENT_TYPES, buildComponentFilter, resolveComponentId, solutionLabel } from './tool-layers.js'

const DEFAULT_LANGUAGE = 1033

/** PublishAllXml gets its own budget: it is a whole-organization operation. */
const PUBLISH_TIMEOUT_MS = 180_000

/**
 * Resolve which option set a request targets: a global one by name, or the
 * local option set owned by a single picklist column.
 */
function optionTarget(request) {
  const optionSetName = String(request?.optionSetName ?? '').trim()
  const entity = String(request?.entity ?? '').trim()
  const attribute = String(request?.attribute ?? '').trim()
  if (entity && attribute) return { kind: 'local', entity, attribute }
  if (optionSetName) return { kind: 'global', name: optionSetName }
  throw new D365Error('缺少 optionSetName，或 entity + attribute（本地选项集）', {
    code: 'missing-option-set',
    hint: '全局选项集传 optionSet；字段自带的选项集传 entity 与 attribute。',
  })
}

/** Human-readable name of an option target. */
function targetLabel(target) {
  return target.kind === 'local' ? `${target.entity}.${target.attribute}` : target.name
}

/**
 * Read one option set — global by name, or the one attached to a column.
 *
 * A column's local option set is only reachable through a type cast; which cast
 * applies depends on whether the column is single- or multi-select, and some
 * deployments reject the multi-select cast for a plain picklist. Trying both
 * beats making the caller know the difference.
 */
async function readOptionSet(client, target, signal) {
  let definition
  if (target.kind === 'local') {
    const base = `EntityDefinitions(LogicalName='${escapeName(target.entity)}')`
      + `/Attributes(LogicalName='${escapeName(target.attribute)}')`
    const params = { $expand: 'OptionSet($select=Options,IsGlobal,Name)' }
    const casts = [
      'Microsoft.Dynamics.CRM.PicklistAttributeMetadata',
      'Microsoft.Dynamics.CRM.MultiSelectPicklistAttributeMetadata',
      '',
    ]
    let failure
    for (const cast of casts) {
      try {
        definition = await client.requestJson(client.buildUrl(cast ? `${base}/${cast}` : base, params), { signal })
        break
      } catch (error) {
        failure = error
      }
    }
    if (!definition) {
      throw new D365Error(`字段 ${target.entity}.${target.attribute} 的选项集读取失败`, {
        code: 'option-set-unreadable',
        hint: `${failure?.message ?? ''} 该字段可能不是选项集字段。`,
      })
    }
  } else {
    definition = await client.requestJson(
      client.buildUrl(`GlobalOptionSets(Name='${escapeName(target.name)}')`),
      { signal },
    ).catch(async () => {
      // Some deployments expose the keyed form under the pluralized entity set.
      return client.requestJson(
        client.buildUrl(`GlobalOptionSetDefinitions(Name='${escapeName(target.name)}')`),
        { signal },
      )
    })
  }

  const source = definition?.OptionSet ?? definition
  const options = (source?.Options ?? []).map((option) => ({
    value: Number(option.Value),
    label: option.Label?.UserLocalizedLabel?.Label
      ?? option.Label?.LocalizedLabels?.[0]?.Label
      ?? '',
  }))
  return { name: source?.Name ?? targetLabel(target), options }
}

function codeOf(label) {
  return String(label ?? '').split('|')[0].trim()
}

/**
 * Verify the solution a change is supposed to land in, before a plan is saved.
 *
 * The `MSCRM.SolutionUniqueName` header only records a change inside an
 * existing, unmanaged solution; a typo would otherwise surface after a person
 * already confirmed the plan. Checking here turns it into a normal planning
 * error with a chance to fix the name first.
 */
async function assertSolution(client, solutionUniqueName, signal) {
  const name = String(solutionUniqueName ?? '').trim()
  if (!name) return
  const safe = name.replace(/'/g, "''")
  const body = await client.requestJson(
    client.buildUrl('solutions', { $select: 'uniquename,ismanaged', $filter: `uniquename eq '${safe}'` }),
    { signal },
  )
  const row = body?.value?.[0]
  if (!row) {
    throw new D365Error(`解决方案不存在：${name}`, {
      code: 'unknown-solution',
      hint: '检查解决方案唯一名。改动只能落在一个已存在的未受管解决方案里；留空则进默认解决方案。',
    })
  }
  const managed = row.ismanaged ?? row.IsManaged
  if (managed) {
    throw new D365Error(`解决方案 ${name} 是受管的，不能写入`, {
      code: 'managed-solution',
      hint: '受管解决方案不能再接受元数据改动；改用承载本项目改动的未受管解决方案。',
    })
  }
}

/**
 * Build an "add missing options" plan.
 * @param request - `{ optionSetName | entity+attribute, labels: string[], solutionUniqueName? }`
 *   where each label is `CODE|Description`.
 */
export async function planOptionAdd(config, envKey, request, signal) {
  const env = config.environments[envKey]
  if (!env) throw new D365Error(`未知环境：${envKey}`, { code: 'unknown-environment' })

  const target = optionTarget(request)
  const labels = Array.isArray(request?.labels) ? request.labels.map((item) => String(item).trim()).filter(Boolean) : []
  if (!labels.length) throw new D365Error('缺少要新增的选项列表（labels）', { code: 'missing-labels' })

  const client = new DataverseClient(env, { timeoutMs: config.timeoutMs })
  await assertSolution(client, request?.solutionUniqueName, signal)
  const { options } = await readOptionSet(client, target, signal)

  const existing = new Map()
  for (const option of options) {
    const code = codeOf(option.label)
    if (code && !existing.has(code)) existing.set(code, option)
  }

  let nextValue = options.length ? Math.max(...options.map((option) => option.value)) + 1 : 1
  const operations = []
  const skipped = []
  const scope = target.kind === 'local'
    ? { entity: target.entity, attribute: target.attribute }
    : { optionSetName: target.name }

  for (const label of labels) {
    const code = codeOf(label)
    if (existing.has(code)) {
      skipped.push({ code, value: existing.get(code).value, label: existing.get(code).label })
      continue
    }
    operations.push({
      type: 'InsertOptionValue',
      ...scope,
      value: nextValue,
      label,
      languageCode: DEFAULT_LANGUAGE,
      solutionUniqueName: request?.solutionUniqueName ?? undefined,
      summary: `${targetLabel(target)} +${nextValue} ${label}`,
    })
    nextValue += 1
  }

  const maxValue = options.length ? Math.max(...options.map((option) => option.value)) : 0
  return {
    kind: 'optionValue.add',
    capability: 'optionValue.add',
    title: `${env.key}：向 ${targetLabel(target)} 新增 ${operations.length} 个选项`,
    envKey: env.key,
    envUrl: env.url,
    ...scope,
    optionTarget: target.kind,
    before: { totalOptions: options.length, maxValue },
    operations,
    skipped,
    requestedBy: request?.requestedBy ?? 'agent',
    rationale: request?.rationale ?? '',
  }
}

/**
 * Build a "relabel existing options" plan.
 * @param request - `{ optionSetName | entity+attribute, updates: [{ value, label }] }`
 */
export async function planOptionRelabel(config, envKey, request, signal) {
  const env = config.environments[envKey]
  if (!env) throw new D365Error(`未知环境：${envKey}`, { code: 'unknown-environment' })

  const target = optionTarget(request)
  const updates = Array.isArray(request?.updates) ? request.updates : []
  if (!updates.length) throw new D365Error('缺少 updates', { code: 'missing-updates' })

  const client = new DataverseClient(env, { timeoutMs: config.timeoutMs })
  await assertSolution(client, request?.solutionUniqueName, signal)
  const { options } = await readOptionSet(client, target, signal)
  const byValue = new Map(options.map((option) => [Number(option.value), option]))
  const scope = target.kind === 'local'
    ? { entity: target.entity, attribute: target.attribute }
    : { optionSetName: target.name }

  const operations = []
  const skipped = []
  for (const update of updates) {
    const value = Number(update?.value)
    const label = String(update?.label ?? '').trim()
    const current = byValue.get(value)
    if (!current) {
      skipped.push({ value, label, reason: '选项不存在' })
      continue
    }
    if (!label || current.label === label) {
      skipped.push({ value, label, reason: '标签相同' })
      continue
    }
    operations.push({
      type: 'UpdateOptionValue',
      ...scope,
      value,
      label,
      languageCode: DEFAULT_LANGUAGE,
      solutionUniqueName: request?.solutionUniqueName ?? undefined,
      previousLabel: current.label,
      summary: `${targetLabel(target)} ~${value} ${current.label} → ${label}`,
    })
  }

  return {
    kind: 'optionValue.updateLabel',
    capability: 'optionValue.updateLabel',
    title: `${env.key}：修改 ${targetLabel(target)} 的 ${operations.length} 个选项标签`,
    envKey: env.key,
    envUrl: env.url,
    ...scope,
    optionTarget: target.kind,
    before: { totalOptions: options.length },
    operations,
    skipped,
    requestedBy: request?.requestedBy ?? 'agent',
    rationale: request?.rationale ?? '',
  }
}

/**
 * Build a "delete option values" plan. Destructive: the caller must acknowledge.
 * @param request - `{ optionSetName | entity+attribute, values: number[], acknowledge: true }`
 */
export async function planOptionDelete(config, envKey, request, signal) {
  const env = config.environments[envKey]
  if (!env) throw new D365Error(`未知环境：${envKey}`, { code: 'unknown-environment' })

  if (request?.acknowledge !== true) {
    throw new D365Error('删除选项值不可恢复，必须先明确确认（acknowledge: true）', {
      code: 'destructive-not-acknowledged',
      hint: '已有数据如果引用该值，删除会失败；能删掉的标签也找不回来。确认后再生成计划。',
    })
  }

  const target = optionTarget(request)
  const values = (Array.isArray(request?.values) ? request.values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
  if (!values.length) throw new D365Error('缺少要删除的选项值（values）', { code: 'missing-values' })

  const client = new DataverseClient(env, { timeoutMs: config.timeoutMs })
  await assertSolution(client, request?.solutionUniqueName, signal)
  const { options } = await readOptionSet(client, target, signal)
  const byValue = new Map(options.map((option) => [Number(option.value), option]))
  const scope = target.kind === 'local'
    ? { entity: target.entity, attribute: target.attribute }
    : { optionSetName: target.name }

  const operations = []
  const skipped = []
  for (const value of values) {
    const current = byValue.get(value)
    if (!current) {
      skipped.push({ value, reason: '选项不存在' })
      continue
    }
    operations.push({
      type: 'DeleteOptionValue',
      ...scope,
      value,
      previousLabel: current.label,
      solutionUniqueName: request?.solutionUniqueName ?? undefined,
      summary: `删除选项 ${value}（${current.label}）`,
    })
  }

  return {
    kind: 'optionValue.delete',
    capability: 'optionValue.delete',
    title: `${env.key}：从 ${targetLabel(target)} 删除 ${operations.length} 个选项`,
    envKey: env.key,
    envUrl: env.url,
    ...scope,
    optionTarget: target.kind,
    before: { totalOptions: options.length },
    operations,
    skipped,
    requestedBy: request?.requestedBy ?? 'agent',
    rationale: request?.rationale ?? '',
  }
}

/** Escape a logical name for use inside an OData key segment. */
function escapeName(value) {
  return String(value ?? '').replace(/'/g, "''").trim()
}

const REQUIRED_LEVELS = ['None', 'Recommended', 'Required']

/** Column kinds this plugin can create, with their metadata defaults. */
const ATTRIBUTE_TYPES = {
  string: {
    label: '文本',
    odata: 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    extra: (request) => ({
      MaxLength: Math.min(4000, Math.max(1, Number(request.maxLength ?? 100) || 100)),
      FormatName: { Value: request.format === 'Email' || request.format === 'Url' ? request.format : 'Text' },
    }),
  },
  memo: {
    label: '多行文本',
    odata: 'Microsoft.Dynamics.CRM.MemoAttributeMetadata',
    extra: (request) => ({ MaxLength: Math.min(1048576, Math.max(1, Number(request.maxLength ?? 2000) || 2000)) }),
  },
  integer: {
    label: '整数',
    odata: 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata',
    extra: () => ({ Format: { Value: 'None' } }),
  },
  decimal: {
    label: '小数',
    odata: 'Microsoft.Dynamics.CRM.DecimalAttributeMetadata',
    extra: (request) => ({ Precision: Math.min(10, Math.max(0, Number(request.precision ?? 2) || 2)) }),
  },
  money: {
    label: '货币',
    odata: 'Microsoft.Dynamics.CRM.MoneyAttributeMetadata',
    extra: (request) => ({
      Precision: Math.min(4, Math.max(0, Number(request.precision ?? 2) || 2)),
      MaxValue: 1000000000000,
      MinValue: -1000000000000,
    }),
  },
  boolean: {
    label: '是/否',
    odata: 'Microsoft.Dynamics.CRM.BooleanAttributeMetadata',
    extra: (request) => {
      const language = Number(request.language ?? DEFAULT_LANGUAGE)
      return {
        DefaultValue: false,
        OptionSet: {
          TrueOption: { Value: 1, Label: labelBody(request.trueLabel ?? '是', language) },
          FalseOption: { Value: 0, Label: labelBody(request.falseLabel ?? '否', language) },
        },
      }
    },
  },
  datetime: {
    label: '日期时间',
    odata: 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata',
    extra: (request) => ({ Format: { Value: request.dateOnly ? 'DateOnly' : 'DateAndTime' } }),
  },
}

/** Build the JSON definition for a new column. */
function attributeDefinition(request) {
  const type = String(request.type ?? 'string').toLowerCase()
  const spec = ATTRIBUTE_TYPES[type]
  if (!spec) {
    throw new D365Error(`不支持的字段类型：${type}`, {
      code: 'bad-attribute-type',
      hint: `可用类型：${Object.keys(ATTRIBUTE_TYPES).join(', ')}`,
    })
  }

  const schemaName = String(request.schemaName ?? '').trim()
  if (!/^[A-Za-z][A-Za-z0-9_]{1,49}$/.test(schemaName)) {
    throw new D365Error(`字段名不合法：${schemaName}`, {
      code: 'bad-schema-name',
      hint: '必须以字母开头，只含字母、数字、下划线，且带发布者前缀（如 new_）。',
    })
  }

  const displayName = String(request.displayName ?? schemaName).trim()
  const language = Number(request.language ?? DEFAULT_LANGUAGE)
  const requiredLevel = REQUIRED_LEVELS.includes(request.requiredLevel) ? request.requiredLevel : 'None'
  const description = String(request.description ?? '').trim()

  return {
    '@odata.type': spec.odata,
    SchemaName: schemaName,
    DisplayName: labelBody(displayName, language),
    ...(description ? { Description: labelBody(description, language) } : {}),
    RequiredLevel: { Value: requiredLevel },
    ...spec.extra({ ...request, language }),
  }
}

/** Read one column's metadata; rejects when it does not exist. */
async function readAttribute(client, entity, logicalName, signal) {
  const path = `EntityDefinitions(LogicalName='${escapeName(entity)}')/Attributes(LogicalName='${escapeName(logicalName)}')`
  return client.requestJson(client.buildUrl(path), { signal })
}

/** Read one table's metadata. */
async function readEntity(client, entity, signal) {
  const path = `EntityDefinitions(LogicalName='${escapeName(entity)}')`
  return client.requestJson(client.buildUrl(path, { $select: 'LogicalName,DisplayName,Description' }), { signal })
    .catch(() => client.requestJson(client.buildUrl(path), { signal }))
}

/** A label's display text, whichever shape the server used. */
function labelText(label) {
  return label?.UserLocalizedLabel?.Label ?? label?.LocalizedLabels?.[0]?.Label ?? ''
}

/**
 * Build a "create a column" plan.
 * @param request - `{ entity, schemaName, displayName?, type?, maxLength?,
 *   precision?, requiredLevel?, description?, language?, solutionUniqueName? }`
 */
export async function planAddAttribute(config, envKey, request, signal) {
  const env = config.environments[envKey]
  if (!env) throw new D365Error(`未知环境：${envKey}`, { code: 'unknown-environment' })

  const entity = String(request?.entity ?? '').trim()
  if (!entity) throw new D365Error('缺少 entity（表逻辑名）', { code: 'missing-entity' })

  const client = new DataverseClient(env, { timeoutMs: config.timeoutMs })
  await assertSolution(client, request?.solutionUniqueName, signal)
  await readEntity(client, entity, signal)

  const definition = attributeDefinition(request)
  const operations = []
  const skipped = []

  const exists = await readAttribute(client, entity, definition.SchemaName, signal).catch(() => null)
  if (exists) {
    skipped.push({ schemaName: definition.SchemaName, reason: '字段已存在' })
  } else {
    operations.push({
      type: 'CreateAttribute',
      entity,
      attribute: definition,
      schemaName: definition.SchemaName,
      solutionUniqueName: request?.solutionUniqueName ?? undefined,
      summary: `${entity}.${definition.SchemaName}（${ATTRIBUTE_TYPES[String(request.type ?? 'string').toLowerCase()].label}）`,
    })
  }

  return {
    kind: 'attribute.add',
    capability: 'attribute.add',
    title: `${env.key}：在 ${entity} 上新增 ${operations.length} 个字段`,
    envKey: env.key,
    envUrl: env.url,
    target: `${entity}.${definition.SchemaName}`,
    before: { entity, exists: Boolean(exists) },
    operations,
    skipped,
    requestedBy: request?.requestedBy ?? 'agent',
    rationale: request?.rationale ?? '',
  }
}

/**
 * Build an "update a column's label" plan.
 * @param request - `{ entity, attribute, displayName?, description?, requiredLevel? }`
 */
export async function planUpdateAttribute(config, envKey, request, signal) {
  const env = config.environments[envKey]
  if (!env) throw new D365Error(`未知环境：${envKey}`, { code: 'unknown-environment' })

  const entity = String(request?.entity ?? '').trim()
  const attributeName = String(request?.attribute ?? request?.schemaName ?? '').trim()
  if (!entity) throw new D365Error('缺少 entity（表逻辑名）', { code: 'missing-entity' })
  if (!attributeName) throw new D365Error('缺少 attribute（字段逻辑名）', { code: 'missing-attribute' })

  const client = new DataverseClient(env, { timeoutMs: config.timeoutMs })
  await assertSolution(client, request?.solutionUniqueName, signal)
  const current = await readAttribute(client, entity, attributeName, signal).catch((error) => {
    throw new D365Error(`字段 ${entity}.${attributeName} 不存在或无法读取`, {
      code: 'attribute-not-found',
      hint: error?.message,
    })
  })

  const language = Number(request?.language ?? DEFAULT_LANGUAGE)
  const changes = {
    '@odata.type': current['@odata.type'] ?? 'Microsoft.Dynamics.CRM.AttributeMetadata',
    LogicalName: current.LogicalName ?? attributeName,
  }
  const before = {
    displayName: labelText(current.DisplayName),
    description: labelText(current.Description),
    requiredLevel: current.RequiredLevel?.Value ?? 'None',
  }
  const parts = []

  const displayName = String(request?.displayName ?? '').trim()
  if (displayName && displayName !== before.displayName) {
    changes.DisplayName = labelBody(displayName, language)
    parts.push(`显示名 ${before.displayName || '∅'}→${displayName}`)
  }
  const description = String(request?.description ?? '').trim()
  if (description && description !== before.description) {
    changes.Description = labelBody(description, language)
    parts.push('描述')
  }
  const requiredLevel = String(request?.requiredLevel ?? '').trim()
  if (requiredLevel && REQUIRED_LEVELS.includes(requiredLevel) && requiredLevel !== before.requiredLevel) {
    changes.RequiredLevel = { Value: requiredLevel }
    parts.push(`必填级别 ${before.requiredLevel}→${requiredLevel}`)
  }

  const operations = parts.length
    ? [{
      type: 'UpdateAttribute',
      entity,
      attributeName: current.LogicalName ?? attributeName,
      changes,
      summary: `${entity}.${current.LogicalName ?? attributeName}：${parts.join('；')}`,
    }]
    : []

  return {
    kind: 'attribute.update',
    capability: 'attribute.update',
    title: `${env.key}：修改 ${entity}.${attributeName} 的显示信息`,
    envKey: env.key,
    envUrl: env.url,
    target: `${entity}.${attributeName}`,
    before,
    operations,
    skipped: operations.length ? [] : [{ attribute: attributeName, reason: '请求的值与现值相同' }],
    requestedBy: request?.requestedBy ?? 'agent',
    rationale: request?.rationale ?? '',
  }
}

/**
 * Build a "delete a column" plan. Destructive: the caller must acknowledge it.
 * @param request - `{ entity, attribute, acknowledge: true }`
 */
export async function planDeleteAttribute(config, envKey, request, signal) {
  const env = config.environments[envKey]
  if (!env) throw new D365Error(`未知环境：${envKey}`, { code: 'unknown-environment' })

  if (request?.acknowledge !== true) {
    throw new D365Error('删除字段不可恢复，必须先明确确认（acknowledge: true）', {
      code: 'destructive-not-acknowledged',
      hint: '这是不可逆操作：列数据随列一起删除。确认后再生成计划，计划仍会在设置页等待人工确认。',
    })
  }

  const entity = String(request?.entity ?? '').trim()
  const attributeName = String(request?.attribute ?? '').trim()
  if (!entity || !attributeName) {
    throw new D365Error('缺少 entity 或 attribute', { code: 'missing-target' })
  }

  const client = new DataverseClient(env, { timeoutMs: config.timeoutMs })
  await assertSolution(client, request?.solutionUniqueName, signal)
  const current = await readAttribute(client, entity, attributeName, signal).catch(() => null)

  const operations = current
    ? [{
      type: 'DeleteAttribute',
      entity,
      attributeName: current.LogicalName ?? attributeName,
      displayName: labelText(current.DisplayName),
      summary: `删除字段 ${entity}.${current.LogicalName ?? attributeName}（${labelText(current.DisplayName) || '无显示名'}）`,
    }]
    : []

  return {
    kind: 'attribute.delete',
    capability: 'attribute.delete',
    title: `${env.key}：删除 ${entity}.${attributeName}`,
    envKey: env.key,
    envUrl: env.url,
    target: `${entity}.${attributeName}`,
    before: { exists: Boolean(current), displayName: labelText(current?.DisplayName) },
    operations,
    skipped: operations.length ? [] : [{ attribute: attributeName, reason: '字段不存在' }],
    requestedBy: request?.requestedBy ?? 'agent',
    rationale: request?.rationale ?? '',
  }
}

/**
 * Build an "update a table's label" plan.
 * @param request - `{ entity, displayName?, description? }`
 */
export async function planUpdateEntity(config, envKey, request, signal) {
  const env = config.environments[envKey]
  if (!env) throw new D365Error(`未知环境：${envKey}`, { code: 'unknown-environment' })

  const entity = String(request?.entity ?? '').trim()
  if (!entity) throw new D365Error('缺少 entity（表逻辑名）', { code: 'missing-entity' })

  const client = new DataverseClient(env, { timeoutMs: config.timeoutMs })
  await assertSolution(client, request?.solutionUniqueName, signal)
  const current = await readEntity(client, entity, signal)

  const language = Number(request?.language ?? DEFAULT_LANGUAGE)
  const before = {
    displayName: labelText(current.DisplayName),
    description: labelText(current.Description),
  }
  const changes = { '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata', LogicalName: current.LogicalName ?? entity }
  const parts = []

  const displayName = String(request?.displayName ?? '').trim()
  if (displayName && displayName !== before.displayName) {
    changes.DisplayName = labelBody(displayName, language)
    parts.push(`显示名 ${before.displayName || '∅'}→${displayName}`)
  }
  const description = String(request?.description ?? '').trim()
  if (description && description !== before.description) {
    changes.Description = labelBody(description, language)
    parts.push('描述')
  }

  const operations = parts.length
    ? [{
      type: 'UpdateEntity',
      entity: current.LogicalName ?? entity,
      changes,
      summary: `${entity}：${parts.join('；')}`,
    }]
    : []

  return {
    kind: 'entity.update',
    capability: 'entity.update',
    title: `${env.key}：修改表 ${entity} 的显示信息`,
    envKey: env.key,
    envUrl: env.url,
    target: entity,
    before,
    operations,
    skipped: operations.length ? [] : [{ entity, reason: '请求的值与现值相同' }],
    requestedBy: request?.requestedBy ?? 'agent',
    rationale: request?.rationale ?? '',
  }
}

/**
 * Build a plan that adds or removes columns of a system view.
 *
 * Only the cell list inside `layoutxml` is rewritten: the filter (`fetchxml`),
 * sorting and conditional formatting stay exactly as they were. Personal views
 * (`userquery`) are deliberately out of reach — their ids are user-specific and
 * editing them from a deployment tool is never what anyone means.
 *
 * @param request - `{ view, entity?, addColumns?: string[], removeColumns?: string[], solutionUniqueName? }`
 */
export async function planViewColumns(config, envKey, request, signal) {
  const env = config.environments[envKey]
  if (!env) throw new D365Error(`未知环境：${envKey}`, { code: 'unknown-environment' })

  const viewName = String(request?.view ?? '').trim()
  if (!viewName) throw new D365Error('缺少 view（视图名）', { code: 'missing-view' })
  const entity = String(request?.entity ?? '').trim()

  const adds = (Array.isArray(request?.addColumns) ? request.addColumns : [])
    .map((item) => String(item).trim())
    .filter(Boolean)
  const removes = (Array.isArray(request?.removeColumns) ? request.removeColumns : [])
    .map((item) => String(item).trim())
    .filter(Boolean)
  if (!adds.length && !removes.length) {
    throw new D365Error('缺少要增删的列（addColumns / removeColumns）', { code: 'missing-columns' })
  }

  const client = new DataverseClient(env, { timeoutMs: config.timeoutMs })
  await assertSolution(client, request?.solutionUniqueName, signal)

  const filter = entity
    ? `name eq '${escapeName(viewName)}' and returnedtypecode eq '${escapeName(entity)}'`
    : `name eq '${escapeName(viewName)}'`
  const body = await client.requestJson(client.buildUrl('savedqueries', {
    $select: 'savedqueryid,name,returnedtypecode,layoutxml,querytype',
    $filter: filter,
  }), { signal })
  const rows = body?.value ?? []
  if (!rows.length) {
    throw new D365Error(`没有找到视图：${viewName}`, {
      code: 'unknown-view',
      hint: entity ? '检查视图名与表逻辑名是否对得上。' : '同名视图可能属于另一张表，补一个 entity 再试。',
    })
  }
  if (rows.length > 1) {
    throw new D365Error(`有 ${rows.length} 个视图叫 ${viewName}，请同时指定 entity`, {
      code: 'ambiguous-view',
      hint: rows.map((row) => row.returnedtypecode).join('、'),
    })
  }

  const view = rows[0]
  const layout = String(view.layoutxml ?? '')
  const rowMatch = /(<row\b[^>]*>)([\s\S]*?)(<\/row>)/.exec(layout)
  if (!rowMatch) {
    throw new D365Error(`视图 ${viewName} 的 layoutxml 结构无法识别`, {
      code: 'unparsable-layout',
      hint: layout.slice(0, 160),
    })
  }

  const cellPattern = /<cell\b[^>]*\/>/g
  let cells = rowMatch[2].match(cellPattern) ?? []
  const present = new Set(cells.map((xml) => /\bname="([^"]+)"/.exec(xml)?.[1]).filter(Boolean))
  const beforeCount = present.size
  const parts = []
  const skipped = []

  for (const attribute of removes) {
    if (!present.has(attribute)) {
      skipped.push({ attribute, reason: '视图里没有这一列' })
      continue
    }
    cells = cells.filter((xml) => /\bname="([^"]+)"/.exec(xml)?.[1] !== attribute)
    present.delete(attribute)
    parts.push(`- ${attribute}`)
  }
  for (const attribute of adds) {
    if (present.has(attribute)) {
      skipped.push({ attribute, reason: '视图里已有这一列' })
      continue
    }
    cells.push(`<cell name="${attribute}" width="100" />`)
    present.add(attribute)
    parts.push(`+ ${attribute}`)
  }

  const operations = parts.length
    ? [{
      type: 'UpdateViewLayout',
      viewId: view.savedqueryid,
      viewName: view.name,
      entity: view.returnedtypecode,
      layoutxml: layout.replace(rowMatch[0], `${rowMatch[1]}${cells.join('')}${rowMatch[3]}`),
      solutionUniqueName: request?.solutionUniqueName ?? undefined,
      summary: `视图「${view.name}」（${view.returnedtypecode}）${parts.join('  ')}`,
    }]
    : []

  return {
    kind: 'view.columns',
    capability: 'view.columns',
    title: `${env.key}：调整视图 ${viewName} 的列`,
    envKey: env.key,
    envUrl: env.url,
    target: `${view.returnedtypecode}/${viewName}`,
    before: { columns: beforeCount },
    operations,
    skipped,
    requestedBy: request?.requestedBy ?? 'agent',
    rationale: request?.rationale ?? '',
  }
}

/**
 * Component types `RemoveActiveCustomizations` accepts, with the numeric
 * `ComponentType` the message expects.
 *
 * The numbers are the `componenttype` picklist values Dataverse itself publishes
 * on `solutioncomponent.componenttype` (read live from the org, not guessed):
 * Entity 1, Attribute 2, Option Set 9, Saved Query 26, Workflow 29, System Form
 * 60, Web Resource 61, Plugin Type 90, Plugin Assembly 91, SDK Message
 * Processing Step 92. `CustomAPI` sits outside that picklist because the table
 * carries its own object type code, which is what `solutioncomponents` stores
 * for it (10519 here).
 */
const REMOVE_LAYER_TYPES = {
  Entity: 1,
  Attribute: 2,
  OptionSet: 9,
  SavedQuery: 26,
  Workflow: 29,
  SystemForm: 60,
  WebResource: 61,
  PluginType: 90,
  PluginAssembly: 91,
  SdkMessageProcessingStep: 92,
  CustomAPI: 10519,
}

/** The unmanaged layer is the one the layer view labels "Active". */
const ACTIVE_LAYER = /^active$/i

const GUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Dataverse answers `objecttypecode` with the literal "none" for a form that is
 * not bound to any table (dashboards, some maintenance forms). Publishing that
 * as an entity name fails the whole PublishXml, so it has to read as "no scope".
 */
const publishEntity = (value) => {
  const name = String(value ?? '').trim()
  return name && name.toLowerCase() !== 'none' ? name : undefined
}

/**
 * Work out what a publish has to cover for a component whose layer is removed.
 *
 * Returns `{ entity }`, `{ optionSetName }` or `{}`; an empty answer means the
 * caller publishes everything, which is correct but slower — never wrong, so a
 * failed lookup is not allowed to block the removal.
 */
async function resolveLayerPublishScope(client, { componentType, componentId, component, entity, signal }) {
  const read = async (path, select) => client.requestJson(
    client.buildUrl(path, { $select: select }),
    { signal },
  )
  try {
    if (componentType === 'Entity') return { entity: publishEntity(component) }
    if (componentType === 'Attribute') return { entity: publishEntity(entity) }
    if (componentType === 'SystemForm') {
      const form = await read(`systemforms(${componentId})`, 'objecttypecode')
      return { entity: publishEntity(form?.objecttypecode) }
    }
    if (componentType === 'SavedQuery') {
      const view = await read(`savedqueries(${componentId})`, 'returnedtypecode')
      return { entity: publishEntity(view?.returnedtypecode) }
    }
    if (componentType === 'OptionSet') {
      // A global option set is published by name; the plan may have been built
      // from a GUID, so read the name back when needed.
      const name = GUID_ONLY.test(component)
        ? (await read(`GlobalOptionSetDefinitions(${componentId})`, 'Name'))?.Name
        : component
      return { optionSetName: name || undefined }
    }
    return {}
  } catch {
    return {}
  }
}

/**
 * Build a "remove the unmanaged layer" plan.
 *
 * Removing a layer deletes the top-most *unmanaged* definition of a component,
 * so whatever a managed solution last brought becomes active again. There is no
 * undo, hence `acknowledge` plus the usual confirmation card.
 * @param request - `{ componentType: 'Entity' | 'Attribute', component, entity?, acknowledge: true }`
 */
export async function planRemoveLayer(config, envKey, request, signal) {
  const env = config.environments[envKey]
  if (!env) throw new D365Error(`未知环境：${envKey}`, { code: 'unknown-environment' })

  if (request?.acknowledge !== true) {
    throw new D365Error('移除自定义层不可恢复，必须先明确确认（acknowledge: true）', {
      code: 'destructive-not-acknowledged',
      hint: '删掉的是未受管的那一层，Dataverse 没有还原入口。确认后再生成计划，执行前仍要在确认卡片上批准。',
    })
  }

  const componentType = String(request?.componentType ?? 'Entity').trim()
  const componentCode = REMOVE_LAYER_TYPES[componentType]
  if (!componentCode) {
    throw new D365Error(`不支持移除层的组件类型：${componentType}`, {
      code: 'bad-component-type',
      hint: `支持的组件类型：${Object.keys(REMOVE_LAYER_TYPES).join('、')}。`
        + '本地选项集不是这里的 OptionSet，它随字段存在，用 componentType=Attribute 加 entity 查字段的层。',
    })
  }

  const component = String(request?.component ?? '').trim()
  const client = new DataverseClient(env, { timeoutMs: config.timeoutMs })
  const componentId = await resolveComponentId(
    client,
    { componentType, component, entity: request?.entity },
    signal,
  )

  const { page } = await getPagedWithSelectFallback(client, 'msdyn_componentlayers', {
    $select: 'msdyn_componentlayerid,msdyn_name,msdyn_solutionname,msdyn_publishername,msdyn_order,msdyn_overwritetime',
    $filter: buildComponentFilter(componentId, componentType),
  }, 50, signal)

  const layers = [...(page?.records ?? [])]
    .sort((a, b) => Number(a.msdyn_order ?? 0) - Number(b.msdyn_order ?? 0))
  if (!layers.length) {
    throw new D365Error(`组件 ${component} 在这个环境里没有任何层记录`, {
      code: 'no-layers',
      hint: '只有进过解决方案、或被直接自定义过的组件才有层；查不到层说明它没被改过，也就没有可删的自定义层。',
    })
  }

  const active = layers[layers.length - 1]
  if (!ACTIVE_LAYER.test(String(active.msdyn_solutionname ?? ''))) {
    throw new D365Error(`最上面一层属于解决方案 ${solutionLabel(active)}，不是未受管的自定义层`, {
      code: 'not-active-layer',
      hint: '这里只删「Active」那一层。要撤掉解决方案带来的定义，得在解决方案里移除组件，或导入一个新 patch 覆盖它。',
    })
  }

  const below = layers.length > 1 ? layers[layers.length - 2] : null
  const shownName = active.msdyn_name ?? component
  // A publish is what makes a metadata change visible, and its scope differs per
  // component type: an entity or column is published through its table, a form
  // or view through the table it belongs to, a global option set by name, and a
  // plugin or web resource needs no publish at all. When the scope cannot be
  // worked out, the caller falls back to publishing everything.
  const publish = await resolveLayerPublishScope(client, {
    componentType, componentId, component, entity: request?.entity, signal,
  })

  const operations = [{
    type: 'RemoveActiveCustomizations',
    componentType: componentCode,
    componentTypeName: componentType,
    componentId,
    entity: publish.entity,
    optionSetName: publish.optionSetName,
    attribute: componentType === 'Attribute' ? component : undefined,
    removedLayer: {
      solution: active.msdyn_solutionname ?? 'Active',
      publisher: active.msdyn_publishername ?? '',
      order: Number(active.msdyn_order ?? 0),
    },
    becomesActive: below
      ? {
        solution: solutionLabel(below),
        publisher: below.msdyn_publishername ?? '',
        order: Number(below.msdyn_order ?? 0),
      }
      : null,
    summary: `移除 ${componentType} ${shownName} 的自定义层（Active）`
      + `；之后生效：${below ? solutionLabel(below) : '系统定义'}`,
  }]

  return {
    kind: 'layer.remove',
    capability: 'layer.remove',
    title: `${env.key}：移除 ${componentType} ${component} 的自定义层`,
    envKey: env.key,
    envUrl: env.url,
    target: `${componentType} ${component}`,
    before: {
      layers: layers.map((layer) => ({
        solution: layer.msdyn_solutionname ?? 'Active',
        publisher: layer.msdyn_publishername ?? '',
        order: Number(layer.msdyn_order ?? 0),
        time: layer.msdyn_overwritetime ?? null,
      })),
      activeLayer: active.msdyn_solutionname ?? 'Active',
      activePublisher: active.msdyn_publishername ?? '',
      becomesActive: below ? solutionLabel(below) : '系统定义',
    },
    operations,
    skipped: [],
    requestedBy: request?.requestedBy ?? 'agent',
    rationale: request?.rationale ?? '',
  }
}

/** Persist a plan so the page can show it. */
export async function savePlan(config, plan) {
  return createPlan(config, plan)
}

/**
 * Option-set action bodies address either a global option set (by name) or a
 * column's local one (by owning column) — never both.
 */
function optionScope(operation) {
  return operation.entity
    ? { EntityLogicalName: operation.entity, AttributeLogicalName: operation.attribute }
    : { OptionSetName: operation.optionSetName }
}

function labelBody(label, languageCode) {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.Label',
    LocalizedLabels: [
      {
        '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel',
        Label: label,
        LanguageCode: languageCode,
      },
    ],
  }
}

/**
 * Execute a plan. Callers must have already confirmed this is a human action.
 * @returns `{ results, failures, ledger }`.
 */
export async function executePlan(config, plan, signal, options = {}) {
  const policy = await readPolicy(config.configFile)
  if (!allows(policy, plan.envKey, plan.capability)) {
    throw new D365Error(`环境 ${plan.envKey} 未授权 ${plan.capability}`, {
      code: 'not-allowed',
      hint: '在设置页的「写入权限」里勾选该环境与能力后再执行。',
    })
  }

  const env = config.environments[plan.envKey]
  if (!env) throw new D365Error(`未知环境：${plan.envKey}`, { code: 'unknown-environment' })
  if (!plan.operations?.length) throw new D365Error('计划中没有操作', { code: 'empty-plan' })
  // Defence in depth: callers check this too, but a plan that already ran must
  // never run again through any path — the operations are not idempotent.
  if ((plan.status ?? 'pending') !== 'pending') {
    throw new D365Error(`计划 ${plan.id} 的状态是 ${plan.status}，不能再次执行`, {
      code: 'plan-not-pending',
      hint: '先核对 .d365/changes 里的记录；要再做一次请重新生成计划。',
    })
  }

  const client = new DataverseClient(env, { timeoutMs: config.timeoutMs })

  // Dataverse holds the customization lock while a solution imports or a
  // publish runs; with Microsoft's own updates that is a lot of the day. Writing
  // into that window means waiting minutes for a lock, or failing outright, so
  // check first and let the person decide with `force`.
  const preflight = await checkEnvironmentIdle(client, {
    windowMinutes: config.busyWindowMinutes,
    signal,
  })
  if (preflight.busy && options.force !== true) throw busyError(plan.envKey, preflight)

  // Claim the plan before the first write. Anything that stops this process
  // mid-plan (crash, killed tab, Host restart) leaves status "running", so the
  // plan cannot be silently executed again and replay the operations that
  // already landed. Callers refuse non-pending plans unless a person forces it.
  await setPlanStatus(config, plan.id, 'running', { startedAt: new Date().toISOString() })

  try {
  const results = []
  const failures = []

  for (const operation of plan.operations) {
    try {
      if (operation.type === 'InsertOptionValue') {
        const body = {
          ...optionScope(operation),
          Value: operation.value,
          Label: labelBody(operation.label, operation.languageCode ?? DEFAULT_LANGUAGE),
        }
        if (operation.solutionUniqueName) body.SolutionUniqueName = operation.solutionUniqueName
        const response = await client.postJson('InsertOptionValue', body, signal)
        results.push({ ...operation, ok: true, returnedValue: response?.Value })
      } else if (operation.type === 'UpdateOptionValue') {
        const body = {
          ...optionScope(operation),
          Value: operation.value,
          Label: labelBody(operation.label, operation.languageCode ?? DEFAULT_LANGUAGE),
          MergeLabels: false,
        }
        if (operation.solutionUniqueName) body.SolutionUniqueName = operation.solutionUniqueName
        await client.postJson('UpdateOptionValue', body, signal)
        results.push({ ...operation, ok: true })
      } else if (operation.type === 'DeleteOptionValue') {
        const body = {
          ...optionScope(operation),
          Value: operation.value,
        }
        if (operation.solutionUniqueName) body.SolutionUniqueName = operation.solutionUniqueName
        await client.postJson('DeleteOptionValue', body, signal)
        results.push({ ...operation, ok: true })
      } else if (operation.type === 'UpdateViewLayout') {
        // SavedQuery is an update message, not an action: patch the layout back.
        // Conditional formatting and the filter (fetchxml) stay untouched.
        const headers = operation.solutionUniqueName
          ? { 'MSCRM.SolutionUniqueName': operation.solutionUniqueName }
          : undefined
        await client.sendJson(`savedqueries(${operation.viewId})`, {
          method: 'PATCH',
          body: { layoutxml: operation.layoutxml },
          headers,
        }, signal)
        results.push({ ...operation, ok: true })
      } else if (operation.type === 'CreateAttribute') {
        // Creating a column is not an action: it is a POST of the typed
        // metadata to the entity's Attributes collection.
        const path = `EntityDefinitions(LogicalName='${escapeName(operation.entity)}')/Attributes`
        const headers = operation.solutionUniqueName
          ? { 'MSCRM.SolutionUniqueName': operation.solutionUniqueName }
          : undefined
        await client.sendJson(path, { method: 'POST', body: operation.attribute, headers }, signal)
        results.push({ ...operation, ok: true })
      } else if (operation.type === 'UpdateAttribute') {
        const path = `EntityDefinitions(LogicalName='${escapeName(operation.entity)}')`
          + `/Attributes(LogicalName='${escapeName(operation.attributeName)}')`
        // `MSCRM.MergeLabels` keeps the organization's other languages; without
        // it the PUT replaces every localized label with the one sent. The
        // solution header makes the change land in that solution's layer, not
        // the unnamed active layer.
        await client.sendJson(path, {
          method: 'PUT',
          body: operation.changes,
          headers: {
            'MSCRM.MergeLabels': 'true',
            ...(operation.solutionUniqueName ? { 'MSCRM.SolutionUniqueName': operation.solutionUniqueName } : {}),
          },
        }, signal)
        results.push({ ...operation, ok: true })
      } else if (operation.type === 'DeleteAttribute') {
        const path = `EntityDefinitions(LogicalName='${escapeName(operation.entity)}')`
          + `/Attributes(LogicalName='${escapeName(operation.attributeName)}')`
        const headers = operation.solutionUniqueName
          ? { 'MSCRM.SolutionUniqueName': operation.solutionUniqueName }
          : undefined
        await client.sendJson(path, { method: 'DELETE', headers }, signal)
        results.push({ ...operation, ok: true })
      } else if (operation.type === 'RemoveActiveCustomizations') {
        // Unbound action: the component type is numeric and the object id is the
        // metadata id resolved when the plan was built.
        await client.postJson('RemoveActiveCustomizations', {
          ComponentType: operation.componentType,
          ObjectId: operation.componentId,
        }, signal)
        results.push({ ...operation, ok: true })
      } else if (operation.type === 'UpdateEntity') {
        const path = `EntityDefinitions(LogicalName='${escapeName(operation.entity)}')`
        await client.sendJson(path, {
          method: 'PUT',
          body: operation.changes,
          headers: {
            'MSCRM.MergeLabels': 'true',
            ...(operation.solutionUniqueName ? { 'MSCRM.SolutionUniqueName': operation.solutionUniqueName } : {}),
          },
        }, signal)
        results.push({ ...operation, ok: true })
      } else {
        failures.push({ operation, error: `不支持的操作类型：${operation.type}` })
      }
    } catch (error) {
      failures.push({
        operation,
        error: error.message,
        hint: error.hint,
      })
    }
  }

  // Metadata changes need a publish to become visible, but a failed publish must
  // not report the writes as failed — they already happened.
  //
  // PublishAllXml walks every component of the organization; on a large one it
  // takes minutes (36 option values once sat unpublished behind a 60s timeout).
  // It therefore runs detached: the person gets the write result immediately,
  // and a sidecar file records how the publish ended.
  let publishState = 'skipped'
  const publishScope = publishTargets(results)
  if (results.length) {
    publishState = 'running'
    const publishClient = new DataverseClient(env, {
      timeoutMs: Math.max(config.timeoutMs ?? 60_000, PUBLISH_TIMEOUT_MS),
      counters: client.counters,
    })
    publishInBackground(config, plan, publishClient, publishScope)
  }

  const ledger = await recordChange(config, {
    planId: plan.id,
    kind: plan.kind,
    envKey: plan.envKey,
    envUrl: plan.envUrl,
    title: plan.title,
    target: plan.target,
    optionSetName: plan.optionSetName,
    capability: plan.capability,
    applied: results,
    failed: failures,
    publishState,
    publishScope,
    preflight: {
      available: preflight.available,
      busy: preflight.busy,
      active: preflight.active,
      stale: preflight.stale.length,
      forced: options.force === true,
    },
  })

  // Terminal state before the caller deletes the file: if that delete fails,
  // the plan still refuses a second run instead of replaying itself.
  await setPlanStatus(config, plan.id, 'done', {
    finishedAt: new Date().toISOString(),
    appliedCount: results.length,
    failedCount: failures.length,
  }).catch(() => {})

  return { results, failures, publishState, publishScope, ledger, preflight }
  } catch (error) {
    // Keep the evidence: the plan stays on disk with the reason it stopped, so
    // the page can show "failed" instead of pretending nothing happened.
    await setPlanStatus(config, plan.id, 'failed', {
      finishedAt: new Date().toISOString(),
      error: String(error?.message ?? error),
    }).catch(() => {})
    throw error
  }
}

/**
 * Fire the publish and forget about the caller's request.
 *
 * Deliberately not awaited: holding an HTTP response open for the duration of a
 * whole-organization publish is what produced "请求超时" while the values were
 * already saved. Failures land in `.d365/changes/publish-<planId>.json`.
 */
function publishInBackground(config, plan, client, scope) {
  const startedAt = new Date().toISOString()
  void publishOn(client, scope)
    .then(async (outcome) => {
      await writePublishReport(config, plan.id, {
        planId: plan.id,
        envKey: plan.envKey,
        startedAt,
        finishedAt: new Date().toISOString(),
        targets: scope,
        ...outcome,
      })
    })
    .catch(() => {})
}

/**
 * Run one publish and resolve with its outcome instead of firing and forgetting.
 *
 * The settings page uses this for "publish again": the person is staring at a
 * failed publish, so the result has to come back while they wait.
 */
export async function publishNow(config, envKey, scope, options = {}) {
  const env = config.environments?.[envKey]
  if (!env) throw new D365Error(`未知环境：${envKey}`, { code: 'unknown-environment' })
  const client = new DataverseClient(env, {
    timeoutMs: Math.max(config.timeoutMs ?? 60_000, PUBLISH_TIMEOUT_MS),
  })
  // A publish started while the organization is importing or publishing is the
  // most common way this fails, and the page is where people retry it. Check
  // first so the answer is "the environment is busy", not a raw 429.
  const preflight = await checkEnvironmentIdle(client, {
    windowMinutes: config.busyWindowMinutes,
    signal: options.signal,
  })
  if (preflight.busy && options.force !== true) throw busyError(envKey, preflight)
  const outcome = await publishOn(client, scope, options.signal)
  return { ...outcome, targets: scope, counters: client.counters }
}

async function publishOn(client, scope, signal) {
  const scoped = (scope?.entities?.length ?? 0) > 0 || (scope?.optionSets?.length ?? 0) > 0
  try {
    if (scoped) await client.postJson('PublishXml', { ParameterXml: buildPublishXml(scope) }, signal)
    else await client.postJson('PublishAllXml', {}, signal)
    return { ok: true, mode: scoped ? 'scoped' : 'all' }
  } catch (error) {
    return { ok: false, mode: scoped ? 'scoped' : 'all', error: error.message, hint: error.hint }
  }
}


/**
 * Which components a publish has to cover.
 *
 * `PublishAllXml` walks every entity and option set in the organization: on a
 * large org that is minutes of CPU, and it is the piece that used to time out.
 * Everything we write is local to an entity or a global option set, so the
 * publish can be narrowed to exactly those.
 */
export function publishTargets(results) {
  const entities = new Set()
  const optionSets = new Set()
  for (const operation of results) {
    switch (operation.type) {
      case 'InsertOptionValue':
      case 'UpdateOptionValue':
      case 'DeleteOptionValue':
        if (operation.entity) entities.add(operation.entity)
        else if (operation.optionSetName) optionSets.add(operation.optionSetName)
        break
      case 'CreateAttribute':
      case 'UpdateAttribute':
      case 'DeleteAttribute':
      case 'UpdateEntity':
      case 'UpdateViewLayout':
        if (operation.entity) entities.add(operation.entity)
        break
      case 'RemoveActiveCustomizations':
        // The message itself names a numeric component type; what has to be
        // published is whichever table (or global option set) owns it.
        if (operation.entity) entities.add(operation.entity)
        else if (operation.optionSetName) optionSets.add(operation.optionSetName)
        break
      default:
        break
    }
  }
  return { entities: [...entities].sort(), optionSets: [...optionSets].sort() }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * `PublishXml` takes an `importexportxml` document listing what to publish; the
 * element order mirrors the solution schema (entities before optionsets).
 */
export function buildPublishXml({ entities = [], optionSets = [] }) {
  const parts = []
  if (entities.length) {
    parts.push(`<entities>${entities.map((name) => `<entity>${escapeXml(name)}</entity>`).join('')}</entities>`)
  }
  if (optionSets.length) {
    parts.push(`<optionsets>${optionSets.map((name) => `<optionset>${escapeXml(name)}</optionset>`).join('')}</optionsets>`)
  }
  return `<importexportxml>${parts.join('')}</importexportxml>`
}
