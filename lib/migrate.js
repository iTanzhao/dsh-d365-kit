import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { D365Error } from './errors.js'
import { dataRoot } from './snapshot.js'
import { DataverseClient } from './client.js'

/** componenttype → the name msdyn_componentlayer uses for it. */
const LAYER_TYPES = {
  1: 'Entity',
  2: 'Attribute',
  9: 'OptionSet',
  10: 'EntityRelationship',
  29: 'Workflow',
  61: 'WebResource',
}

const TYPE_LABELS = {
  1: '表',
  2: '字段',
  9: '选项集',
  10: '关系',
  29: '流程',
  61: 'Web 资源',
  36: '视图/图表类',
  50: '安全/扩展类',
  70: '应用类',
}

const DEFAULT_MAX_COMPONENTS = 150
const DEFAULT_CONCURRENCY = 4
const MAX_CONCURRENCY = 8

/** Run `worker` over `items` with at most `limit` in flight, keeping order. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

function typeLabel(type) {
  return TYPE_LABELS[type] ?? `类型 ${type}`
}

function layerType(type) {
  return LAYER_TYPES[type] ?? null
}

function envLabel(config, key) {
  return config.environments[key]?.label || key
}

/** Parse msdyn_componentjson into a plain key/value map. */
function componentFields(json) {
  if (!json) return {}
  let payload
  try {
    payload = JSON.parse(json)
  } catch {
    return {}
  }
  const fields = {}
  for (const attribute of payload.Attributes ?? []) fields[attribute.Key] = attribute.Value
  return fields
}

function labelText(label) {
  if (!label) return ''
  const localized = Array.isArray(label.LocalizedLabels) ? label.LocalizedLabels : []
  const preferred = localized.find((item) => item.LanguageCode === 2052) ?? localized[0]
  return preferred?.Label ?? ''
}

function normalizeVersion(value) {
  return String(value ?? '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
}

/** True when `left` is strictly newer than `right`. */
function versionNewer(left, right) {
  const a = normalizeVersion(left)
  const b = normalizeVersion(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    if (x !== y) return x > y
  }
  return false
}

async function requestAll(client, path, params, signal) {
  const rows = []
  let url = client.buildUrl(path, params)
  let guard = 0
  while (url) {
    const page = await client.requestJson(url, { signal })
    rows.push(...(page.value ?? []))
    url = page['@odata.nextLink']
    guard += 1
    if (guard > 200) break
  }
  return rows
}

/** Query that degrades instead of failing when an endpoint rejects a parameter. */
async function tryQuery(client, path, params, signal) {
  const attempts = [params, { ...params, $select: undefined }, { ...params, $select: undefined, $top: undefined }]
  let lastError
  for (const attempt of attempts) {
    const cleaned = Object.fromEntries(Object.entries(attempt).filter(([, value]) => value !== undefined))
    try {
      const page = await client.requestJson(client.buildUrl(path, cleaned), { signal })
      return page.value ?? []
    } catch (error) {
      if (error?.status !== 400) throw error
      lastError = error
    }
  }
  throw lastError
}

async function findSolution(client, uniqueName, signal) {
  const rows = await tryQuery(client, 'solutions', {
    $filter: `uniquename eq '${uniqueName.replace(/'/g, "''")}'`,
    $select: 'solutionid,uniquename,friendlyname,version,ismanaged,installedon,publisherid,description',
  }, signal)
  const row = rows.find((item) => String(item.uniquename).toLowerCase() === uniqueName.toLowerCase())
  if (!row) return null
  let publisher = null
  if (row.publisherid) {
    try {
      const publishers = await tryQuery(client, 'publishers', {
        $filter: `publisherid eq ${row.publisherid}`,
        $select: 'publisherid,uniquename,customizationprefix,friendlyname',
      }, signal)
      publisher = publishers[0] ?? null
    } catch {
      publisher = null
    }
  }
  return { ...row, publisher }
}

async function listComponents(client, solutionId, signal) {
  return requestAll(client, 'solutioncomponents', {
    $filter: `_solutionid_value eq ${solutionId}`,
    $select: 'solutioncomponentid,componenttype,objectid,rootcomponentbehavior',
  }, signal)
}

/** MetadataId → LogicalName map, used to resolve attribute owners. */
async function entityNameMap(client, signal) {
  const rows = await tryQuery(client, 'EntityDefinitions', { $select: 'MetadataId,LogicalName' }, signal)
  const map = new Map()
  for (const row of rows) map.set(String(row.MetadataId).toLowerCase(), row.LogicalName)
  return map
}

async function readLayers(client, componentId, typeName, signal) {
  try {
    const rows = await tryQuery(client, 'msdyn_componentlayers', {
      $filter: `msdyn_componentid eq '${componentId}' and msdyn_solutioncomponentname eq '${typeName}'`,
      $select: 'msdyn_name,msdyn_solutionname,msdyn_order,msdyn_publishername,msdyn_overwritetime,msdyn_componentjson',
    }, signal)
    return rows
  } catch (error) {
    if (error?.status === 400 || error?.status === 404) return []
    throw error
  }
}

/** Work out the cross-environment identity of one component. */
function componentKey(kind, component, topLayer, entities) {
  const fields = componentFields(topLayer?.msdyn_componentjson)
  switch (kind) {
    case 1:
      return { key: fields.logicalname ?? topLayer?.msdyn_name ?? null, extra: {} }
    case 2: {
      const entityKey = fields.entityid ? entities.get(String(fields.entityid).toLowerCase()) : null
      const attributeName = fields.logicalname ?? topLayer?.msdyn_name ?? null
      return { key: attributeName, extra: { entity: entityKey } }
    }
    case 9:
      return { key: fields.name ?? topLayer?.msdyn_name ?? null, extra: {} }
    case 10:
      return { key: fields.schemaname ?? topLayer?.msdyn_name ?? null, extra: {} }
    case 29:
      return { key: fields.name ?? topLayer?.msdyn_name ?? null, extra: { category: fields.category?.Value ?? null } }
    case 61:
      return { key: fields.name ?? topLayer?.msdyn_name ?? null, extra: {} }
    default:
      return { key: null, extra: {} }
  }
}

/** Does the component exist in this environment? */
async function probe(client, kind, resolved, entities, signal) {
  const { key, extra } = resolved
  const quote = (value) => String(value).replace(/'/g, "''")
  switch (kind) {
    case 1: {
      const rows = await tryQuery(client, 'EntityDefinitions', {
        $filter: `LogicalName eq '${quote(key)}'`,
        $select: 'MetadataId,LogicalName',
      }, signal)
      return rows[0] ? { exists: true, id: rows[0].MetadataId, display: rows[0].LogicalName } : { exists: false }
    }
    case 2: {
      if (!extra.entity) return { exists: false, unknown: '无法确定所属表' }
      const entityId = entities.get(String(extra.entity).toLowerCase()) ?? extra.entity
      const rows = await tryQuery(client, `EntityDefinitions(LogicalName='${quote(entityId)}')/Attributes`, {
        $filter: `LogicalName eq '${quote(key)}'`,
        $select: 'MetadataId,LogicalName',
      }, signal)
      return rows[0] ? { exists: true, id: rows[0].MetadataId, display: `${entityId}.${rows[0].LogicalName}` } : { exists: false }
    }
    case 9: {
      try {
        const definition = await client.requestJson(
          client.buildUrl(`GlobalOptionSetDefinitions(Name='${quote(key)}')/Microsoft.Dynamics.CRM.OptionSetMetadata`),
          { signal },
        )
        return { exists: true, id: definition.MetadataId, display: definition.Name, options: definition.Options ?? [] }
      } catch (error) {
        if (error?.status === 404) return { exists: false }
        throw error
      }
    }
    case 10: {
      const rows = await tryQuery(client, 'RelationshipDefinitions', {
        $filter: `SchemaName eq '${quote(key)}'`,
        $select: 'SchemaName,MetadataId',
      }, signal)
      return rows[0] ? { exists: true, id: rows[0].MetadataId, display: rows[0].SchemaName } : { exists: false }
    }
    case 29: {
      const rows = await tryQuery(client, 'workflows', {
        $filter: `name eq '${quote(key)}'`,
        $select: 'workflowid,name,category,type,statecode,statuscode,modifiedon',
      }, signal)
      const match = extra.category === null ? rows[0] : rows.find((row) => row.category === extra.category) ?? rows[0]
      return match ? { exists: true, id: match.workflowid, display: match.name, statecode: match.statecode } : { exists: false }
    }
    case 61: {
      const rows = await tryQuery(client, 'webresourceset', {
        $filter: `name eq '${quote(key)}'`,
        $select: 'webresourceid,name,webresourcetype,modifiedon,ismanaged',
      }, signal)
      return rows[0]
        ? { exists: true, id: rows[0].webresourceid, display: rows[0].name, modifiedon: rows[0].modifiedon }
        : { exists: false }
    }
    default:
      return { exists: null, unknown: '未知组件类型' }
  }
}

function solutionNameOf(layer) {
  return layer?.msdyn_solutionname || '(系统/活动层)'
}

/** Summarise the option values of one option set. */
function optionIndex(options) {
  const map = new Map()
  for (const option of options ?? []) {
    map.set(Number(option.Value), labelText(option.Label))
  }
  return map
}

function compareOptions(sourceOptions, targetOptions) {
  const source = optionIndex(sourceOptions)
  const target = optionIndex(targetOptions)
  const targetOnly = [...target.keys()].filter((value) => !source.has(value))
  const sourceOnly = [...source.keys()].filter((value) => !target.has(value))
  let labelDrift = 0
  for (const [value, label] of source) {
    if (target.has(value) && target.get(value) !== label) labelDrift += 1
  }
  return { sourceCount: source.size, targetCount: target.size, targetOnly, sourceOnly, labelDrift }
}

function formatList(values, limit = 6) {
  if (!values.length) return '—'
  const head = values.slice(0, limit).join('、')
  return values.length > limit ? `${head} 等 ${values.length} 个` : head
}

function severityOf(findings, severity) {
  return findings.filter((finding) => finding.severity === severity)
}

function renderMarkdown(report) {
  const lines = []
  lines.push(`# 迁移评估：${report.solution.uniqueName} → ${report.target.label}`, '')
  lines.push(`- 源环境：${report.source.label}（${report.source.url}）`)
  lines.push(`- 目标环境：${report.target.label}（${report.target.url}）`)
  lines.push(`- 生成时间：${report.generatedAt}`, '')

  lines.push('## 结论', '')
  lines.push(report.verdict.summary, '')
  if (report.verdict.recommendation) {
    lines.push(`建议：${report.verdict.recommendation}`, '')
  }

  lines.push('## 解决方案', '')
  lines.push('| | 源环境 | 目标环境 |', '| --- | --- | --- |')
  lines.push(`| 是否存在 | ${report.solution.sourceExists ? '是' : '否'} | ${report.solution.targetExists ? '是' : '否'} |`)
  lines.push(`| 版本 | ${report.solution.sourceVersion ?? '—'} | ${report.solution.targetVersion ?? '—'} |`)
  lines.push(`| 受管 | ${report.solution.sourceManaged ? '是' : '否'} | ${report.solution.targetManaged === null ? '—' : report.solution.targetManaged ? '是' : '否'} |`)
  if (report.solution.publisher) {
    lines.push(`| 发布者 | ${report.solution.publisher}（前缀 ${report.solution.prefix ?? '—'}） | |`)
  }
  lines.push('')

  lines.push('## 组件总览', '')
  lines.push('| 类型 | 组件数 | 目标缺失 | 目标已有层 | 无法定位 |', '| --- | --- | --- | --- | --- |')
  for (const row of report.componentRows) {
    lines.push(`| ${row.label} | ${row.total} | ${row.missing} | ${row.withLayers} | ${row.unresolved} |`)
  }
  lines.push('')

  if (report.truncated) {
    lines.push(`> 组件超过 maxComponents=${report.maxComponents}，本次只评估了 ${report.evaluated} 个；传 full: true 可全量评估。`, '')
  }

  const shadowed = report.shadowedSolutions
  if (shadowed.length) {
    lines.push('## 将被遮蔽的解决方案', '')
    lines.push('导入后本方案层位于最上层，下列解决方案在这些组件上的定义将不再生效：', '')
    for (const item of shadowed.slice(0, 20)) {
      lines.push(`- ${item.solution}：${item.count} 个组件（${formatList(item.examples, 4)}）`)
    }
    if (shadowed.length > 20) lines.push(`- … 其余 ${shadowed.length - 20} 个`)
    lines.push('')
  }

  const missing = report.findings.filter((finding) => finding.code === 'component-missing')
  if (missing.length) {
    lines.push('## 目标环境没有的组件', '')
    for (const finding of missing.slice(0, 25)) {
      lines.push(`- ${finding.title}`)
    }
    if (missing.length > 25) lines.push(`- … 其余 ${missing.length - 25} 个`)
    lines.push('')
  }

  if (report.optionSets.length) {
    lines.push('## 选项集数据对比', '')
    lines.push('| 选项集 | 源值数 | 目标值数 | 源多出 | 目标多出（会丢） | 标签不一致 |', '| --- | --- | --- | --- | --- | --- |')
    for (const item of report.optionSets) {
      lines.push(`| ${item.name} | ${item.sourceCount} | ${item.targetCount} | ${item.sourceOnly.length} | ${item.targetOnly.length} | ${item.labelDrift} |`)
    }
    lines.push('')
    for (const item of report.optionSets) {
      if (item.targetOnly.length) {
        lines.push(`> ${item.name}：目标环境独有 ${item.targetOnly.length} 个值（${formatList(item.targetOnly.map(String), 8)}），导入后会丢失。`)
      }
    }
    if (report.optionSets.some((item) => item.targetOnly.length)) lines.push('')
  }

  for (const severity of ['critical', 'warning', 'info']) {
    const group = severityOf(report.findings, severity)
    if (!group.length) continue
    lines.push(`## ${severity === 'critical' ? '严重' : severity === 'warning' ? '警告' : '提示'}`, '')
    for (const finding of group) {
      lines.push(`- **${finding.title}**${finding.detail ? `：${finding.detail}` : ''}`)
    }
    lines.push('')
  }

  lines.push('## 说明', '')
  lines.push('- 层信息来自 `msdyn_componentlayer` 虚拟实体，只能按「组件 id + 组件类型」逐个查。')
  lines.push('- 层叠顺序由导入时间决定，与版本号无关：谁后导入谁在上。')
  lines.push('- 组件是否存在于目标环境按名称/逻辑名匹配，跨环境 id 不可复用。')
  lines.push('- 未评估的组件类型只做了存在性判断，层信息不可用。')
  return lines.join('\n')
}

/**
 * Assess the risk of importing one solution into other environments.
 */
export async function assessMigration(config, request, signal) {
  const sourceKey = request.source || config.defaultEnvironment
  const sourceEnv = config.environments[sourceKey]
  if (!sourceEnv) {
    throw new D365Error(`源环境不存在：${sourceKey}`, {
      code: 'unknown-environment',
      hint: `可用环境：${Object.keys(config.environments).join('、')}`,
    })
  }
  const solutionName = String(request.solution ?? '').trim()
  if (!solutionName) {
    throw new D365Error('缺少 solution：要评估的解决方案唯一名', { code: 'missing-solution' })
  }
  const targetKeys = (request.targets?.length ? request.targets : Object.keys(config.environments).filter((key) => key !== sourceKey))
  for (const key of targetKeys) {
    if (!config.environments[key]) {
      throw new D365Error(`目标环境不存在：${key}`, {
        code: 'unknown-environment',
        hint: `可用环境：${Object.keys(config.environments).join('、')}`,
      })
    }
  }

  const timeoutMs = config.timeoutMs
  const source = new DataverseClient(sourceEnv, { timeoutMs })
  const maxComponents = Number.isFinite(request.maxComponents) && request.maxComponents > 0
    ? Math.trunc(request.maxComponents)
    : DEFAULT_MAX_COMPONENTS
  const concurrency = Math.min(
    MAX_CONCURRENCY,
    Math.max(1, Math.trunc(Number(request.concurrency) || DEFAULT_CONCURRENCY)),
  )

  const solution = await findSolution(source, solutionName, signal)
  if (!solution) {
    const available = await tryQuery(source, 'solutions', { $select: 'uniquename', $top: 50 }, signal)
    const sample = available.slice(0, 10).map((row) => row.uniquename).join('、')
    throw new D365Error(`源环境 ${sourceKey} 没有解决方案 ${solutionName}`, {
      code: 'unknown-solution',
      hint: sample ? `已安装的解决方案例如：${sample}` : undefined,
    })
  }

  const components = await listComponents(source, solution.solutionid, signal)
  const truncated = components.length > maxComponents && request.full !== true
  const evaluated = truncated ? components.slice(0, maxComponents) : components

  const needsEntities = evaluated.some((component) => component.componenttype === 2)
  const entities = needsEntities ? await entityNameMap(source, signal) : new Map()

  const resolved = await mapLimit(evaluated, concurrency, async (component) => {
    const typeName = layerType(component.componenttype)
    const layers = typeName ? await readLayers(source, component.objectid, typeName, signal) : []
    const sorted = layers.slice().sort((a, b) => (Number(a.msdyn_order) || 0) - (Number(b.msdyn_order) || 0))
    const top = sorted[sorted.length - 1] ?? null
    const key = componentKey(component.componenttype, component, top, entities)
    return {
      component,
      layerType: typeName,
      layers: sorted,
      top,
      resolved: key,
      sourceLabel: top?.msdyn_name ?? key.key ?? String(component.objectid).slice(0, 8),
    }
  })

  const optionCache = new Map()
  const targets = await Promise.all(targetKeys.map(async (targetKey) => {
    const targetEnv = config.environments[targetKey]
    const target = new DataverseClient(targetEnv, { timeoutMs })
    const targetSolution = await findSolution(target, solution.uniquename, signal)
    const targetEntities = needsEntities ? await entityNameMap(target, signal) : new Map()
    const findings = []
    const optionSets = []
    const shadowed = new Map()
    const buckets = []
    const missing = []
    const unresolved = []

    if (!targetSolution) {
      findings.push({
        severity: 'warning',
        confidence: 'high',
        code: 'solution-absent',
        title: `目标环境没有解决方案 ${solution.uniquename}`,
        detail: '导入后会新建一个 unmanaged 层，无法通过卸载解决方案清除',
      })
    } else {
      if (!versionNewer(solution.version, targetSolution.version)) {
        findings.push({
          severity: 'warning',
          confidence: 'high',
          code: 'version-not-newer',
          title: `目标版本 ${targetSolution.version} 不低于源版本 ${solution.version}`,
          detail: '导入后版本号可能不递增，后续升级判断会失真',
        })
      }
      if (targetSolution.ismanaged !== solution.ismanaged) {
        findings.push({
          severity: 'warning',
          confidence: 'high',
          code: 'managed-mismatch',
          title: `受管状态不一致：源 ${solution.ismanaged ? '受管' : '未受管'}，目标 ${targetSolution.ismanaged ? '受管' : '未受管'}`,
          detail: '未受管解决方案导入会形成不可卸载的层',
        })
      }
    }

    if (solution.ismanaged === false) {
      findings.push({
        severity: 'warning',
        confidence: 'high',
        code: 'source-unmanaged',
        title: '源解决方案未受管',
        detail: '导入后目标环境形成 unmanaged 层，只能逐组件删层，无法用卸载解决方案回退',
      })
    }

    await mapLimit(resolved, concurrency, async (item) => {
      const { component, layerType: typeName, sourceLabel, resolved: key } = item
      const kind = component.componenttype
      const bucket = { type: kind, label: typeLabel(kind), name: sourceLabel, key: key.key }
      buckets.push(bucket)
      if (!typeName) {
        bucket.status = 'unresolved'
        unresolved.push(bucket)
        return
      }
      if (!key.key) {
        bucket.status = 'unresolved'
        unresolved.push(bucket)
        return
      }
      let result
      try {
        result = await probe(target, kind, key, targetEntities, signal)
      } catch (error) {
        bucket.status = 'error'
        bucket.error = error instanceof Error ? error.message : String(error)
        unresolved.push(bucket)
        return
      }
      bucket.display = result.display ?? sourceLabel
      if (result.unknown) {
        bucket.status = 'unresolved'
        bucket.unknown = result.unknown
        unresolved.push(bucket)
        return
      }
      if (!result.exists) {
        bucket.status = 'missing'
        missing.push(bucket)
        findings.push({
          severity: 'info',
          confidence: 'high',
          code: 'component-missing',
          title: `${typeLabel(kind)}「${bucket.display}」在目标环境不存在`,
          detail: '导入时会作为新组件创建',
        })
        return
      }
      bucket.status = 'present'
      const targetLayers = typeName ? await readLayers(target, result.id, typeName, signal) : []
      const sorted = targetLayers.slice().sort((a, b) => (Number(a.msdyn_order) || 0) - (Number(b.msdyn_order) || 0))
      const top = sorted[sorted.length - 1] ?? null
      bucket.topLayer = solutionNameOf(top)
      bucket.layerCount = sorted.length
      for (const layer of sorted) {
        const name = layer.msdyn_solutionname
        if (!name) continue
        if (!shadowed.has(name)) shadowed.set(name, { solution: name, count: 0, examples: [] })
        const entry = shadowed.get(name)
        entry.count += 1
        if (entry.examples.length < 8) entry.examples.push(bucket.display)
      }
      if (kind === 9 && result.options) {
        const comparison = await compareOptionSet(source, target, key.key, result.options, signal, optionCache)
        if (comparison) {
          optionSets.push({ name: bucket.display, ...comparison })
          if (comparison.targetOnly.length) {
            findings.push({
              severity: 'critical',
              confidence: 'high',
              code: 'option-values-lost',
              title: `选项集 ${bucket.display} 在目标环境多出 ${comparison.targetOnly.length} 个值`,
              detail: '导入后这些值会被覆盖掉，引用它们的数据可能失效',
            })
          }
          if (comparison.labelDrift) {
            findings.push({
              severity: 'warning',
              confidence: 'high',
              code: 'option-label-drift',
              title: `选项集 ${bucket.display} 有 ${comparison.labelDrift} 个标签与源环境不一致`,
              detail: '导入后会被源环境的标签覆盖',
            })
          }
        }
      }
    })

    const byType = new Map()
    for (const bucket of buckets) {
      const entry = byType.get(bucket.type) ?? {
        type: bucket.type,
        label: bucket.label,
        total: 0,
        missing: 0,
        withLayers: 0,
        unresolved: 0,
      }
      entry.total += 1
      if (bucket.status === 'missing') entry.missing += 1
      else if (bucket.status === 'present') entry.withLayers += 1
      else entry.unresolved += 1
      byType.set(bucket.type, entry)
    }
    const componentRows = [...byType.values()].sort((a, b) => b.total - a.total)

    const shadowedSolutions = [...shadowed.values()].sort((a, b) => b.count - a.count)
    const missingCount = missing.length
    const critical = findings.filter((finding) => finding.severity === 'critical').length
    const warnings = findings.filter((finding) => finding.severity === 'warning').length
    const verdict = {
      summary: critical
        ? `发现 ${critical} 个严重问题：${formatList(findings.filter((f) => f.severity === 'critical').map((f) => f.title), 3)}`
        : `没有发现数据丢失风险；${missingCount} 个组件在目标环境不存在，${shadowedSolutions.length} 个解决方案的层会被遮蔽。`,
      recommendation: critical
        ? '先处理严重问题再发布：把变更并回受管解决方案，或先在目标环境补齐缺失值。'
        : shadowedSolutions.length
          ? '如果这些遮蔽不可接受，考虑把改动并入目标环境已有的受管解决方案，随其升级导入。'
          : null,
    }

    return {
      key: targetKey,
      label: envLabel(config, targetKey),
      url: targetEnv.url,
      findings,
      critical,
      warnings,
      missing,
      unresolved,
      optionSets,
      shadowedSolutions,
      componentRows,
      verdict,
      targetSolution: targetSolution
        ? { exists: true, version: targetSolution.version, managed: targetSolution.ismanaged }
        : { exists: false, version: null, managed: null },
    }
  }))

  const reports = []
  const root = join(dataRoot(config), 'reports')
  await mkdir(root, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const target of targets) {
    const report = {
      generatedAt: new Date().toISOString(),
      source: { key: sourceKey, label: envLabel(config, sourceKey), url: sourceEnv.url },
      target,
      solution: {
        uniqueName: solution.uniquename,
        friendlyName: solution.friendlyname,
        sourceExists: true,
        targetExists: target.targetSolution.exists,
        sourceVersion: solution.version,
        targetVersion: target.targetSolution.version,
        sourceManaged: solution.ismanaged,
        targetManaged: target.targetSolution.managed,
        publisher: solution.publisher?.friendlyname ?? solution.publisher?.uniquename ?? null,
        prefix: solution.publisher?.customizationprefix ?? null,
      },
      truncated,
      maxComponents,
      evaluated: resolved.length,
      componentRows: target.componentRows,
      shadowedSolutions: target.shadowedSolutions,
      optionSets: target.optionSets,
      findings: target.findings,
      verdict: target.verdict,
    }
    const markdown = renderMarkdown(report)
    const base = `migration-${solution.uniquename}-to-${target.key}-${stamp}`.replace(/[^a-zA-Z0-9._-]+/g, '-')
    const mdFile = join(root, `${base}.md`)
    const jsonFile = join(root, `${base}.json`)
    await writeFile(mdFile, `${markdown}\n`, 'utf8')
    await writeFile(jsonFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    reports.push({
      target: target.key,
      targetLabel: target.label,
      critical: target.critical,
      warnings: target.warnings,
      missing: target.missing.length,
      shadowed: target.shadowedSolutions.length,
      verdict: target.verdict,
      reportPath: mdFile.replace(/\\/g, '/'),
      jsonPath: jsonFile.replace(/\\/g, '/'),
    })
  }

  return {
    source: { key: sourceKey, label: envLabel(config, sourceKey) },
    solution: solution.uniquename,
    componentCount: components.length,
    evaluated: resolved.length,
    truncated,
    maxComponents,
    reports,
  }
}

/** Compare one global option set between two environments. */
async function compareOptionSet(source, target, name, targetOptions, signal, cache = null) {
  const quote = String(name).replace(/'/g, "''")
  try {
    let pending = cache?.get(name)
    if (!pending) {
      pending = source.requestJson(
        source.buildUrl(`GlobalOptionSetDefinitions(Name='${quote}')/Microsoft.Dynamics.CRM.OptionSetMetadata`),
        { signal },
      )
      cache?.set(name, pending)
    }
    const definition = await pending
    return compareOptions(definition.Options ?? [], targetOptions)
  } catch {
    return null
  }
}
