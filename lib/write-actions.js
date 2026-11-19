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
import { t } from './i18n.js'
import { busyError, checkEnvironmentIdle } from './preflight.js'
import { allows, readPolicy } from './write-policy.js'
import { createPlan, claimPlan, readPlan, recordChange, releasePlan, setPlanStatus, writePublishReport } from './write-store.js'
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
  throw new D365Error(t('writeActions.missingOptionSet'), {
    code: 'missing-option-set',
    hint: t('writeActions.optionSetHint'),
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
      throw new D365Error(t('writeActions.optionSetUnreadable', { target: `${target.entity}.${target.attribute}` }), {
        code: 'option-set-unreadable',
        hint: t('writeActions.optionSetUnreadableHint', { error: failure?.message ?? '' }),
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
    throw new D365Error(t('writeActions.solutionMissing', { name }), {
      code: 'unknown-solution',
      hint: t('writeActions.solutionMissingHint'),
    })
  }
  const managed = row.ismanaged ?? row.IsManaged
  if (managed) {
    throw new D365Error(t('writeActions.solutionManaged', { name }), {
      code: 'managed-solution',
      hint: t('writeActions.solutionManagedHint'),
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
  if (!env) throw new D365Error(t('writeActions.unknownEnvironment', { env: envKey }), { code: 'unknown-environment' })

  const target = optionTarget(request)
  const labels = Array.isArray(request?.labels) ? request.labels.map((item) => String(item).trim()).filter(Boolean) : []
  if (!labels.length) throw new D365Error(t('writeActions.missingLabels'), { code: 'missing-labels' })

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
      languageCode: optionLanguage(request),
      solutionUniqueName: request?.solutionUniqueName ?? undefined,
      summary: `${targetLabel(target)} +${nextValue} ${label}`,
    })
    nextValue += 1
  }

  const maxValue = options.length ? Math.max(...options.map((option) => option.value)) : 0
  return {
    kind: 'optionValue.add',
    capability: 'optionValue.add',
    title: t('writeActions.addOptionsTitle', { env: env.key, target: targetLabel(target), count: operations.length }),
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
  if (!env) throw new D365Error(t('writeActions.unknownEnvironment', { env: envKey }), { code: 'unknown-environment' })

  const target = optionTarget(request)
  const updates = Array.isArray(request?.updates) ? request.updates : []
  if (!updates.length) throw new D365Error(t('writeActions.missingUpdates'), { code: 'missing-updates' })

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
      skipped.push({ value, label, reason: t('writeActions.optionMissing') })
      continue
    }
    if (!label || current.label === label) {
      skipped.push({ value, label, reason: t('writeActions.labelSame') })
      continue
    }
    operations.push({
      type: 'UpdateOptionValue',
      ...scope,
      value,
      label,
      languageCode: optionLanguage(request),
      solutionUniqueName: request?.solutionUniqueName ?? undefined,
      previousLabel: current.label,
      summary: `${targetLabel(target)} ~${value} ${current.label} → ${label}`,
    })
  }

  return {
    kind: 'optionValue.updateLabel',
    capability: 'optionValue.updateLabel',
    title: t('writeActions.relabelTitle', { env: env.key, target: targetLabel(target), count: operations.length }),
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
  if (!env) throw new D365Error(t('writeActions.unknownEnvironment', { env: envKey }), { code: 'unknown-environment' })

  if (request?.acknowledge !== true) {
    throw new D365Error(t('writeActions.deleteOptionsAcknowledge'), {
      code: 'destructive-not-acknowledged',
      hint: t('writeActions.deleteOptionsHint'),
    })
  }

  const target = optionTarget(request)
  const values = (Array.isArray(request?.values) ? request.values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
  if (!values.length) throw new D365Error(t('writeActions.missingValues'), { code: 'missing-values' })

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
      skipped.push({ value, reason: t('writeActions.optionMissing') })
      continue
    }
    operations.push({
      type: 'DeleteOptionValue',
      ...scope,
      value,
      previousLabel: current.label,
      solutionUniqueName: request?.solutionUniqueName ?? undefined,
      summary: t('writeActions.deleteOptionSummary', { value, label: current.label }),
    })
  }

  return {
    kind: 'optionValue.delete',
    capability: 'optionValue.delete',
    title: t('writeActions.deleteOptionsTitle', { env: env.key, target: targetLabel(target), count: operations.length }),
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
    label: 'Text',
    odata: 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    extra: (request) => ({
      MaxLength: Math.min(4000, Math.max(1, Number(request.maxLength ?? 100) || 100)),
      FormatName: { Value: request.format === 'Email' || request.format === 'Url' ? request.format : 'Text' },
    }),
  },
  memo: {
    label: 'Multiline text',
    odata: 'Microsoft.Dynamics.CRM.MemoAttributeMetadata',
    extra: (request) => ({ MaxLength: Math.min(1048576, Math.max(1, Number(request.maxLength ?? 2000) || 2000)) }),
  },
  integer: {
    label: 'Integer',
    odata: 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata',
    extra: () => ({ Format: { Value: 'None' } }),
  },
  decimal: {
    label: 'Decimal',
    odata: 'Microsoft.Dynamics.CRM.DecimalAttributeMetadata',
    extra: (request) => ({ Precision: Math.min(10, Math.max(0, Number(request.precision ?? 2) || 2)) }),
  },
  money: {
    label: 'Currency',
    odata: 'Microsoft.Dynamics.CRM.MoneyAttributeMetadata',
    extra: (request) => ({
      Precision: Math.min(4, Math.max(0, Number(request.precision ?? 2) || 2)),
      MaxValue: 1000000000000,
      MinValue: -1000000000000,
    }),
  },
  boolean: {
    label: 'Yes/No',
    odata: 'Microsoft.Dynamics.CRM.BooleanAttributeMetadata',
    extra: (request) => {
      const language = Number(request.language ?? DEFAULT_LANGUAGE)
      return {
        DefaultValue: false,
        OptionSet: {
          TrueOption: { Value: 1, Label: labelBody(request.trueLabel ?? t('writeActions.yes'), language) },
          FalseOption: { Value: 0, Label: labelBody(request.falseLabel ?? t('writeActions.no'), language) },
        },
      }
    },
  },
  datetime: {
    label: 'Date and time',
    odata: 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata',
    extra: (request) => ({ Format: { Value: request.dateOnly ? 'DateOnly' : 'DateAndTime' } }),
  },
}

/** Build the JSON definition for a new column. */
function attributeDefinition(request) {
  const type = String(request.type ?? 'string').toLowerCase()
  const spec = ATTRIBUTE_TYPES[type]
  if (!spec) {
    throw new D365Error(t('writeActions.unsupportedAttributeType', { type }), {
      code: 'bad-attribute-type',
      hint: t('writeActions.availableTypes', { values: Object.keys(ATTRIBUTE_TYPES).join(', ') }),
    })
  }

  const schemaName = String(request.schemaName ?? '').trim()
  if (!/^[A-Za-z][A-Za-z0-9_]{1,49}$/.test(schemaName)) {
    throw new D365Error(t('writeActions.invalidSchemaName', { name: schemaName }), {
      code: 'bad-schema-name',
      hint: t('writeActions.schemaNameHint'),
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
  if (!env) throw new D365Error(t('writeActions.unknownEnvironment', { env: envKey }), { code: 'unknown-environment' })

  const entity = String(request?.entity ?? '').trim()
  if (!entity) throw new D365Error(t('writeActions.missingEntity'), { code: 'missing-entity' })

  const client = new DataverseClient(env, { timeoutMs: config.timeoutMs })
  await assertSolution(client, request?.solutionUniqueName, signal)
  await readEntity(client, entity, signal)

  const definition = attributeDefinition(request)
  const operations = []
  const skipped = []

  const exists = await readAttribute(client, entity, definition.SchemaName, signal).catch(() => null)
  if (exists) {
    skipped.push({ schemaName: definition.SchemaName, reason: t('writeActions.attributeExists') })
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
    title: t('writeActions.addAttributeTitle', { env: env.key, entity, count: operations.length }),
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
  if (!env) throw new D365Error(t('writeActions.unknownEnvironment', { env: envKey }), { code: 'unknown-environment' })

  const entity = String(request?.entity ?? '').trim()
  const attributeName = String(request?.attribute ?? request?.schemaName ?? '').trim()
  if (!entity) throw new D365Error(t('writeActions.missingEntity'), { code: 'missing-entity' })
  if (!attributeName) throw new D365Error(t('writeActions.missingAttribute'), { code: 'missing-attribute' })

  const client = new DataverseClient(env, { timeoutMs: config.timeoutMs })
  await assertSolution(client, request?.solutionUniqueName, signal)
  const current = await readAttribute(client, entity, attributeName, signal).catch((error) => {
    throw new D365Error(t('writeActions.attributeUnreadable', { target: `${entity}.${attributeName}` }), {
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
    parts.push(t('writeActions.displayNameChange', { before: before.displayName || '∅', after: displayName }))
  }
  const description = String(request?.description ?? '').trim()
  if (description && description !== before.description) {
    changes.Description = labelBody(description, language)
    parts.push(t('writeActions.description'))
  }
  const requiredLevel = String(request?.requiredLevel ?? '').trim()
  if (requiredLevel && REQUIRED_LEVELS.includes(requiredLevel) && requiredLevel !== before.requiredLevel) {
    changes.RequiredLevel = { Value: requiredLevel }
    parts.push(t('writeActions.requiredLevelChange', { before: before.requiredLevel, after: requiredLevel }))
  }

  const operations = parts.length
    ? [{
      type: 'UpdateAttribute',
      entity,
      attributeName: current.LogicalName ?? attributeName,
      changes,
      solutionUniqueName: request?.solutionUniqueName ?? undefined,
      summary: `${entity}.${current.LogicalName ?? attributeName}：${parts.join('; ')}`,
    }]
    : []

  return {
    kind: 'attribute.update',
    capability: 'attribute.update',
    title: t('writeActions.updateAttributeTitle', { env: env.key, entity, attribute: attributeName }),
    envKey: env.key,
    envUrl: env.url,
    target: `${entity}.${attributeName}`,
    before,
    operations,
    skipped: operations.length ? [] : [{ attribute: attributeName, reason: t('writeActions.sameAsCurrent') }],
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
  if (!env) throw new D365Error(t('writeActions.unknownEnvironment', { env: envKey }), { code: 'unknown-environment' })

  if (request?.acknowledge !== true) {
    throw new D365Error(t('writeActions.deleteAttributeAcknowledge'), {
      code: 'destructive-not-acknowledged',
      hint: t('writeActions.deleteAttributeHint'),
    })
  }

  const entity = String(request?.entity ?? '').trim()
  const attributeName = String(request?.attribute ?? '').trim()
  if (!entity || !attributeName) {
    throw new D365Error(t('writeActions.missingTarget'), { code: 'missing-target' })
  }

  const client = new DataverseClient(env, { timeoutMs: config.timeoutMs })
  await assertSolution(client, request?.solutionUniqueName, signal)
  const current = await readAttribute(client, entity, attributeName, signal).catch(() => null)

  const operations = current
    ? [{
      type: 'DeleteAttribute',
      entity,
      attributeName: current.LogicalName ?? attributeName,
      // Without this the delete lands in the default solution instead of the
      // one the caller named — the other planners all carry it.
      solutionUniqueName: request?.solutionUniqueName ?? undefined,
      displayName: labelText(current.DisplayName),
      summary: t('writeActions.deleteAttributeSummary', { target: `${entity}.${current.LogicalName ?? attributeName}`, label: labelText(current.DisplayName) || t('writeActions.noDisplayName') }),
    }]
    : []

  return {
    kind: 'attribute.delete',
    capability: 'attribute.delete',
    title: t('writeActions.deleteAttributeTitle', { env: env.key, entity, attribute: attributeName }),
    envKey: env.key,
    envUrl: env.url,
    target: `${entity}.${attributeName}`,
    before: { exists: Boolean(current), displayName: labelText(current?.DisplayName) },
    operations,
    skipped: operations.length ? [] : [{ attribute: attributeName, reason: t('writeActions.attributeMissing') }],
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
  if (!env) throw new D365Error(t('writeActions.unknownEnvironment', { env: envKey }), { code: 'unknown-environment' })

  const entity = String(request?.entity ?? '').trim()
  if (!entity) throw new D365Error(t('writeActions.missingEntity'), { code: 'missing-entity' })

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
    parts.push(t('writeActions.displayNameChange', { before: before.displayName || '∅', after: displayName }))
  }
  const description = String(request?.description ?? '').trim()
  if (description && description !== before.description) {
    changes.Description = labelBody(description, language)
    parts.push(t('writeActions.description'))
  }

  const operations = parts.length
    ? [{
      type: 'UpdateEntity',
      entity: current.LogicalName ?? entity,
      changes,
      solutionUniqueName: request?.solutionUniqueName ?? undefined,
      summary: `${entity}：${parts.join('; ')}`,
    }]
    : []

  return {
    kind: 'entity.update',
    capability: 'entity.update',
    title: t('writeActions.updateEntityTitle', { env: env.key, entity }),
    envKey: env.key,
    envUrl: env.url,
    target: entity,
    before,
    operations,
    skipped: operations.length ? [] : [{ entity, reason: t('writeActions.sameAsCurrent') }],
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
  if (!env) throw new D365Error(t('writeActions.unknownEnvironment', { env: envKey }), { code: 'unknown-environment' })

  const viewName = String(request?.view ?? '').trim()
  if (!viewName) throw new D365Error(t('writeActions.missingView'), { code: 'missing-view' })
  const entity = String(request?.entity ?? '').trim()

  const adds = (Array.isArray(request?.addColumns) ? request.addColumns : [])
    .map((item) => String(item).trim())
    .filter(Boolean)
  const removes = (Array.isArray(request?.removeColumns) ? request.removeColumns : [])
    .map((item) => String(item).trim())
    .filter(Boolean)
  if (!adds.length && !removes.length) {
    throw new D365Error(t('writeActions.missingColumns'), { code: 'missing-columns' })
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
    throw new D365Error(t('writeActions.viewMissing', { view: viewName }), {
      code: 'unknown-view',
      hint: entity ? t('writeActions.viewMissingHintEntity') : t('writeActions.viewMissingHintNoEntity'),
    })
  }
  if (rows.length > 1) {
    throw new D365Error(t('writeActions.viewAmbiguous', { count: rows.length, view: viewName }), {
      code: 'ambiguous-view',
      hint: rows.map((row) => row.returnedtypecode).join(', '),
    })
  }

  const view = rows[0]
  const layout = String(view.layoutxml ?? '')
  const rowMatch = /(<row\b[^>]*>)([\s\S]*?)(<\/row>)/.exec(layout)
  if (!rowMatch) {
    throw new D365Error(t('writeActions.layoutUnreadable', { view: viewName }), {
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
      skipped.push({ attribute, reason: t('writeActions.viewColumnMissing') })
      continue
    }
    cells = cells.filter((xml) => /\bname="([^"]+)"/.exec(xml)?.[1] !== attribute)
    present.delete(attribute)
    parts.push(`- ${attribute}`)
  }
  for (const attribute of adds) {
    if (present.has(attribute)) {
      skipped.push({ attribute, reason: t('writeActions.viewColumnExists') })
      continue
    }
    // A column name is XML text: it goes into an attribute value and must not be
    // able to close the tag or open a new one.
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(attribute)) {
      throw new D365Error(t('writeActions.invalidAttributeName', { attribute }), { code: 'bad-attribute', hint: t('writeActions.attributeNameHint') })
    }
    cells.push(`<cell name="${attribute}" width="100" />`)
    present.add(attribute)
    parts.push(`+ ${attribute}`)
  }

  const rebuilt = `${rowMatch[1]}${cells.join('')}${rowMatch[3]}`
  const operations = parts.length
    ? [{
      type: 'UpdateViewLayout',
      viewId: view.savedqueryid,
      viewName: view.name,
      entity: view.returnedtypecode,
      // A function replacement: a layout string containing `$&` or `$1` would be
      // expanded by String.prototype.replace's special patterns otherwise.
      layoutxml: layout.replace(rowMatch[0], () => rebuilt),
      solutionUniqueName: request?.solutionUniqueName ?? undefined,
      summary: t('writeActions.viewSummary', { name: view.name, entity: view.returnedtypecode, changes: parts.join('  ') }),
    }]
    : []

  return {
    kind: 'view.columns',
    capability: 'view.columns',
    title: t('writeActions.viewTitle', { env: env.key, view: viewName }),
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
  if (!name || name.toLowerCase() === 'none') return undefined
  // A caller may address a table by GUID; a GUID is not a table name, and
  // putting it in PublishXml fails the whole publish.
  if (GUID_ONLY.test(name)) return undefined
  return name
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
  if (!env) throw new D365Error(t('writeActions.unknownEnvironment', { env: envKey }), { code: 'unknown-environment' })

  if (request?.acknowledge !== true) {
    throw new D365Error(t('writeActions.removeLayerAcknowledge'), {
      code: 'destructive-not-acknowledged',
      hint: t('writeActions.removeLayerHint'),
    })
  }

  const componentType = String(request?.componentType ?? 'Entity').trim()
  const componentCode = REMOVE_LAYER_TYPES[componentType]
  if (!componentCode) {
    throw new D365Error(t('writeActions.unsupportedLayerType', { type: componentType }), {
      code: 'bad-component-type',
      hint: t('writeActions.layerTypesHint', { values: Object.keys(REMOVE_LAYER_TYPES).join(', ') }),
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
    throw new D365Error(t('writeActions.noLayers', { component }), {
      code: 'no-layers',
      hint: t('writeActions.noLayersHint'),
    })
  }

  const active = layers[layers.length - 1]
  if (!ACTIVE_LAYER.test(String(active.msdyn_solutionname ?? ''))) {
    throw new D365Error(t('writeActions.notActiveLayer', { solution: solutionLabel(active) }), {
      code: 'not-active-layer',
      hint: t('writeActions.notActiveLayerHint'),
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
    summary: t('writeActions.removeLayerSummary', { type: componentType, name: shownName, active: below ? solutionLabel(below) : t('writeActions.systemDefinition') }),
  }]

  return {
    kind: 'layer.remove',
    capability: 'layer.remove',
    title: t('writeActions.removeLayerTitle', { env: env.key, type: componentType, component }),
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
      becomesActive: below ? solutionLabel(below) : t('writeActions.systemDefinition'),
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

/**
 * Language a new or changed option label is written in. `language` is a real
 * parameter of the plan actions; dropping it silently wrote 1033 (English) into
 * a 2052 organization and left the Chinese label untouched.
 */
function optionLanguage(request) {
  const value = Number(request?.language)
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_LANGUAGE
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

/** One line, no control characters: an operation summary is rendered inside a card. */
export function oneLine(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim()
}

/**
 * The capability each operation type actually needs.
 *
 * The plan file carries a `capability` field, but the file is on disk and can be
 * edited: a plan that says "metadata.read" and deletes a column must not be
 * trusted. The allow-list is derived from the operations the executor really
 * knows, and anything outside it is refused rather than dispatched.
 */
const OPERATION_CAPABILITIES = {
  InsertOptionValue: ['optionValue.add'],
  UpdateOptionValue: ['optionValue.updateLabel'],
  DeleteOptionValue: ['optionValue.delete'],
  CreateAttribute: ['attribute.add'],
  UpdateAttribute: ['attribute.update'],
  DeleteAttribute: ['attribute.delete'],
  UpdateEntity: ['entity.update'],
  UpdateViewLayout: ['view.columns'],
  RemoveActiveCustomizations: ['layer.remove'],
}

function requiredCapabilities(plan) {
  const required = new Set()
  for (const operation of plan.operations ?? []) {
    const found = OPERATION_CAPABILITIES[operation?.type]
    if (!found) {
      throw new D365Error(t('writeActions.unknownOperation', { type: operation?.type }), {
        code: 'bad-plan',
        hint: t('writeActions.doNotEditPlan'),
      })
    }
    for (const capability of found) required.add(capability)
  }
  return required
}

/** Compare environment URLs ignoring a trailing slash and case. */
function sameEnvironmentUrl(a, b) {
  if (!a || !b) return true
  const normalize = (value) => String(value).trim().replace(/\/+$/, '').toLowerCase()
  return normalize(a) === normalize(b)
}

function planGoneError(id) {
  return new D365Error(t('writeActions.planGone', { id }), {
    code: 'plan-gone',
    hint: t('writeActions.planGoneHint'),
  })
}

function planNotPendingError(plan) {
  return new D365Error(t('writeActions.planNotPending', { id: plan.id, status: plan.status }), {
    code: 'plan-not-pending',
    hint: t('writeActions.planNotPendingHint'),
  })
}

/**
 * Execute a plan. Callers must have already confirmed this is a human action.
 * @returns `{ results, failures, ledger }`.
 */
export async function executePlan(config, plan, signal, options = {}) {
  if (plan.kind === 'access' || (plan.operations ?? []).some((operation) => String(operation?.type ?? '').endsWith('Role'))) {
    throw new D365Error(t('writeActions.rolePlanWrongExecutor'), {
      code: 'wrong-executor',
      hint: t('writeActions.rolePlanWrongExecutorHint'),
    })
  }
  const policy = await readPolicy(config.configFile)
  // Check what the operations need, not what the plan file claims. A forged plan
  // with a low `capability` must not turn into a delete.
  for (const capability of requiredCapabilities(plan)) {
    if (!allows(policy, plan.envKey, capability)) {
      throw new D365Error(t('writeActions.environmentNotAllowed', { env: plan.envKey, capability }), {
        code: 'not-allowed',
        hint: t('writeActions.notAllowedHint'),
      })
    }
  }

  const env = config.environments[plan.envKey]
  if (!env) throw new D365Error(t('writeActions.unknownEnvironment', { env: plan.envKey }), { code: 'unknown-environment' })
  if (!plan.operations?.length) throw new D365Error(t('writeActions.emptyPlan'), { code: 'empty-plan' })
  // Defence in depth: callers check this too, but a plan that already ran must
  // never run again through any path — the operations are not idempotent.
  if ((plan.status ?? 'pending') !== 'pending') throw planNotPendingError(plan)

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

  // Take the plan exclusively, then read it back. Two front ends (the chat card
  // and the settings page, or one page in two tabs) both see "pending" from the
  // list call; only one of them can create the lock file, so only one proceeds.
  await claimPlan(config, plan.id)
  let target
  try {
    target = await readPlan(config, plan.id)
    // The page's cancel deletes the file; approving that same plan afterwards
    // must do nothing rather than run the operations it still remembers.
    if (!target || (target.status ?? 'pending') !== 'pending') throw planGoneError(plan.id)
    // The address can be edited between planning and confirming. The card showed
    // the old one, so writing to the new one would not be what was approved.
    if (!sameEnvironmentUrl(target.envUrl, env.url)) {
      throw new D365Error(t('writeActions.environmentChanged', { env: plan.envKey }), {
        code: 'environment-changed',
        hint: t('writeActions.environmentChangedHint', { planned: target.envUrl, current: env.url }),
      })
    }
    // The file, not the caller's copy, is what will actually run: check its
    // operations too, so swapping the plan on disk between the list call and
    // the claim cannot turn an approved edit into something else.
    for (const capability of requiredCapabilities(target)) {
      if (!allows(policy, target.envKey, capability)) {
        throw new D365Error(t('writeActions.environmentNotAllowed', { env: target.envKey, capability }), {
          code: 'not-allowed',
          hint: t('writeActions.planChangedHint'),
        })
      }
    }
    if (!target.operations?.length) throw new D365Error(t('writeActions.emptyPlan'), { code: 'empty-plan' })
  } catch (error) {
    await releasePlan(config, plan.id)
    throw error
  }

  try {
    // Claim the plan in its file before the first write. Anything that stops this
    // process mid-plan (crash, killed tab, Host restart) leaves status "running",
    // so the plan cannot be silently executed again and replay the operations that
    // already landed.
    await setPlanStatus(config, target.id, 'running', { startedAt: new Date().toISOString() })

    // Write the intent before the first write: a crash mid-plan must leave a
    // ledger entry saying what was about to happen, not nothing at all.
    const intent = await recordChange(config, {
      planId: target.id,
      kind: target.kind,
      envKey: target.envKey,
      envUrl: target.envUrl,
      title: target.title,
      target: target.target,
      optionSetName: target.optionSetName,
      capability: target.capability,
      requiredCapabilities: [...requiredCapabilities(target)],
      status: 'running',
      startedAt: new Date().toISOString(),
      applied: [],
      failed: [],
    })

    const results = []
    const failures = []

    for (const operation of target.operations) {
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
            // `MergeLabels: false` replaced the whole label, so every other
            // language the organization had for this option was dropped. Merging
            // updates only the language in `Label`.
            MergeLabels: true,
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
          failures.push({ operation, error: t('writeActions.unsupportedOperation', { type: operation.type }) })
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
      publishInBackground(config, target, publishClient, publishScope)
    }

    // Same file as the intent entry: the ledger must end with one row per plan
    // that says how it went, not two rows that disagree.
    const ledger = await recordChange(config, {
      planId: target.id,
      kind: target.kind,
      envKey: target.envKey,
      envUrl: target.envUrl,
      title: target.title,
      target: target.target,
      optionSetName: target.optionSetName,
      capability: target.capability,
      requiredCapabilities: [...requiredCapabilities(target)],
      status: 'done',
      applied: results,
      failed: failures,
      publishState,
      publishScope,
      finishedAt: new Date().toISOString(),
      preflight: {
        available: preflight.available,
        busy: preflight.busy,
        active: preflight.active,
        stale: preflight.stale.length,
        forced: options.force === true,
      },
    }, intent)

    // Terminal state before the caller deletes the file: if that delete fails,
    // the plan still refuses a second run instead of replaying itself.
    await setPlanStatus(config, target.id, 'done', {
      finishedAt: new Date().toISOString(),
      appliedCount: results.length,
      failedCount: failures.length,
    }).catch(() => {})

    return { results, failures, publishState, publishScope, ledger, preflight }
  } catch (error) {
    // Keep the evidence: the plan stays on disk with the reason it stopped, so
    // the page can show "failed" instead of pretending nothing happened.
    await setPlanStatus(config, target.id, 'failed', {
      finishedAt: new Date().toISOString(),
      error: String(error?.message ?? error),
    }).catch(() => {})
    throw error
  } finally {
    // The lock is a claim, not a tombstone: the plan file already records the
    // outcome, so the next person can see (and regenerate from) it.
    await releasePlan(config, target.id)
  }
}

/**
 * Fire the publish and forget about the caller's request.
 *
 * Deliberately not awaited: holding an HTTP response open for the duration of a
 * whole-organization publish is what produced a request-timeout while the values were
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
  if (!env) throw new D365Error(t('writeActions.unknownEnvironment', { env: envKey }), { code: 'unknown-environment' })
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
