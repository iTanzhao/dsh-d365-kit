import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { D365Error } from './errors.js'
import { dataRoot } from './snapshot.js'
import { DataverseClient } from './client.js'
import { t } from './i18n.js'

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
  1: () => t('migration.type.entity'),
  2: () => t('migration.type.attribute'),
  9: () => t('migration.type.optionSet'),
  10: () => t('migration.type.relationship'),
  29: () => t('migration.type.workflow'),
  61: () => t('migration.type.webResource'),
  36: () => t('migration.type.viewChart'),
  50: () => t('migration.type.securityExtension'),
  70: () => t('migration.type.application'),
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
  return TYPE_LABELS[type]?.() ?? t('migration.type.unknown', { type })
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
      if (!extra.entity) return { exists: false, unknown: t('migration.unknown.entityOwner') }
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
      return { exists: null, unknown: t('migration.unknown.componentType') }
  }
}

function solutionNameOf(layer) {
  return layer?.msdyn_solutionname || t('migration.systemLayer')
}

/** `Active` is Dataverse's pseudo-solution for unmanaged layers, not a solution. */
function isActiveLayerName(name) {
  return /^active$/i.test(String(name ?? ''))
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
  const head = values.slice(0, limit).join(', ')
  return values.length > limit ? t('migration.listMore', { head, count: values.length }) : head
}

function severityOf(findings, severity) {
  return findings.filter((finding) => finding.severity === severity)
}

function renderMarkdown(report) {
  const lines = []
  const yn = (value) => t(value ? 'migration.yes' : 'migration.no')
  lines.push(t('migration.report.title', { solution: report.solution.uniqueName, target: report.target.label }), '')
  lines.push(t('migration.report.source', { label: report.source.label, url: report.source.url }))
  lines.push(t('migration.report.target', { label: report.target.label, url: report.target.url }))
  lines.push(t('migration.report.generated', { at: report.generatedAt }), '')
  lines.push(t('migration.report.verdictHeading'), '', report.verdict.summary, '')
  if (report.verdict.recommendation) lines.push(t('migration.report.recommendation', { text: report.verdict.recommendation }), '')
  lines.push(t('migration.report.solutionHeading'), '')
  lines.push(t('migration.report.solutionTableHeader'), t('migration.report.tableDivider'))
  lines.push(t('migration.report.existsRow', { source: yn(report.solution.sourceExists), target: yn(report.solution.targetExists) }))
  lines.push(t('migration.report.versionRow', { source: report.solution.sourceVersion ?? '—', target: report.solution.targetVersion ?? '—' }))
  const targetManaged = report.solution.targetManaged === null ? '—' : yn(report.solution.targetManaged)
  lines.push(t('migration.report.managedRow', { source: yn(report.solution.sourceManaged), target: targetManaged }))
  if (report.solution.publisher) lines.push(t('migration.report.publisherRow', { publisher: report.solution.publisher, prefix: report.solution.prefix ?? '—' }))
  lines.push('')
  lines.push(t('migration.report.componentsHeading'), '')
  lines.push(t('migration.report.componentsTableHeader'), t('migration.report.componentsDivider'))
  for (const row of report.componentRows) lines.push(t('migration.report.componentRow', row))
  lines.push('')
  if (report.truncated) lines.push(t('migration.report.truncated', { max: report.maxComponents, evaluated: report.evaluated }), '')
  const unresolved = report.unresolved ?? []
  if (unresolved.length) {
    lines.push(t('migration.report.unresolvedHeading'), '')
    lines.push(t('migration.report.unresolvedIntro'), '')
    for (const item of unresolved.slice(0, 25)) {
      const name = item.name ?? item.key ?? '—'
      const reason = item.status === 'error'
        ? t('migration.report.probeFailed', { error: item.error ?? t('migration.unknownError') })
        : item.unknown ? t('migration.report.cannotLocate', { reason: item.unknown }) : t('migration.report.unmappedComponent')
      lines.push(t('migration.report.unresolvedItem', { label: item.label ?? t('migration.type.unknown', { type: item.type }), name, reason }))
    }
    if (unresolved.length > 25) lines.push(t('migration.report.remaining', { count: unresolved.length - 25 }))
    lines.push('')
  }
  const shadowed = report.shadowedSolutions
  if (shadowed.length) {
    lines.push(t('migration.report.shadowedHeading'), '', t('migration.report.shadowedIntro'), '')
    for (const item of shadowed.slice(0, 20)) lines.push(t('migration.report.shadowedItem', { solution: item.solution, count: item.count, examples: formatList(item.examples, 4) }))
    if (shadowed.length > 20) lines.push(t('migration.report.remaining', { count: shadowed.length - 20 }))
    lines.push('')
  }
  const missing = report.findings.filter((finding) => finding.code === 'component-missing')
  if (missing.length) {
    lines.push(t('migration.report.missingHeading'), '')
    for (const finding of missing.slice(0, 25)) lines.push('- ' + finding.title)
    if (missing.length > 25) lines.push(t('migration.report.remaining', { count: missing.length - 25 }))
    lines.push('')
  }
  if (report.optionSets.length) {
    lines.push(t('migration.report.optionsHeading'), '', t('migration.report.optionsTableHeader'), t('migration.report.optionsDivider'))
    for (const item of report.optionSets) lines.push(t('migration.report.optionsRow', item))
    lines.push('')
    for (const item of report.optionSets) if (item.targetOnly.length) lines.push(t('migration.report.optionLoss', { name: item.name, count: item.targetOnly.length, values: formatList(item.targetOnly.map(String), 8) }))
    if (report.optionSets.some((item) => item.targetOnly.length)) lines.push('')
  }
  for (const severity of ['critical', 'warning', 'info']) {
    const group = severityOf(report.findings, severity)
    if (!group.length) continue
    lines.push(t('migration.severity.' + severity), '')
    for (const finding of group) lines.push('- **' + finding.title + '**' + (finding.detail ? ': ' + finding.detail : ''))
    lines.push('')
  }
  lines.push(t('migration.report.notesHeading'), '')
  for (const note of ['layerQuery', 'layerOrder', 'identity', 'unmapped']) lines.push(t('migration.note.' + note))
  return lines.join('\n')
}

export async function assessMigration(config, request, signal) {
  const sourceKey = request.source || config.defaultEnvironment
  const sourceEnv = config.environments[sourceKey]
  if (!sourceEnv) {
    throw new D365Error(t('migration.error.sourceEnvironmentMissing', { key: sourceKey }), {
      code: 'unknown-environment',
      hint: t('migration.error.availableEnvironments', { list: Object.keys(config.environments).join(', ') }),
    })
  }
  const solutionName = String(request.solution ?? '').trim()
  if (!solutionName) {
    throw new D365Error(t('migration.error.missingSolution'), { code: 'missing-solution' })
  }
  const targetKeys = (request.targets?.length ? request.targets : Object.keys(config.environments).filter((key) => key !== sourceKey))
  for (const key of targetKeys) {
    if (!config.environments[key]) {
      throw new D365Error(t('migration.error.targetEnvironmentMissing', { key }), {
        code: 'unknown-environment',
        hint: t('migration.error.availableEnvironments', { list: Object.keys(config.environments).join(', ') }),
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
    const sample = available.slice(0, 10).map((row) => row.uniquename).join(', ')
    throw new D365Error(t('migration.error.solutionMissing', { source: sourceKey, solution: solutionName }), {
      code: 'unknown-solution',
      hint: sample ? t('migration.error.solutionExamples', { sample }) : undefined,
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
        title: t('migration.finding.solutionAbsentTitle', { solution: solution.uniquename }),
        detail: t('migration.finding.solutionAbsentDetail'),
      })
    } else {
      if (!versionNewer(solution.version, targetSolution.version)) {
        findings.push({
          severity: 'warning',
          confidence: 'high',
          code: 'version-not-newer',
          title: t('migration.finding.versionNotNewerTitle', { target: targetSolution.version, source: solution.version }),
          detail: t('migration.finding.versionNotNewerDetail'),
        })
      }
      if (targetSolution.ismanaged !== solution.ismanaged) {
        findings.push({
          severity: 'warning',
          confidence: 'high',
          code: 'managed-mismatch',
          title: t('migration.finding.managedMismatchTitle', { source: t(solution.ismanaged ? 'migration.managed' : 'migration.unmanaged'), target: t(targetSolution.ismanaged ? 'migration.managed' : 'migration.unmanaged') }),
          detail: t('migration.finding.managedMismatchDetail'),
        })
      }
    }

    if (solution.ismanaged === false) {
      findings.push({
        severity: 'warning',
        confidence: 'high',
        code: 'source-unmanaged',
        title: t('migration.finding.sourceUnmanagedTitle'),
        detail: t('migration.finding.sourceUnmanagedDetail'),
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
          title: t('migration.finding.componentMissingTitle', { type: typeLabel(kind), name: bucket.display }),
          detail: t('migration.finding.componentMissingDetail'),
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
        // Two names are not "other solutions that get shadowed": `Active` is
        // Dataverse's pseudo-solution for unmanaged layers, and the solution
        // being imported is the one that will replace these layers, not lose.
        if (isActiveLayerName(name)) continue
        if (name.toLowerCase() === String(solution.uniquename ?? '').toLowerCase()) continue
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
              title: t('migration.finding.optionLossTitle', { name: bucket.display, count: comparison.targetOnly.length }),
              detail: t('migration.finding.optionLossDetail'),
            })
          }
          if (comparison.labelDrift) {
            findings.push({
              severity: 'warning',
              confidence: 'high',
              code: 'option-label-drift',
              title: t('migration.finding.optionDriftTitle', { name: bucket.display, count: comparison.labelDrift }),
              detail: t('migration.finding.optionDriftDetail'),
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
    const unresolvedCount = unresolved.length
    const critical = findings.filter((finding) => finding.severity === 'critical').length
    const warnings = findings.filter((finding) => finding.severity === 'warning').length
    const verdict = {
      // Only a fully checked run may say "no risk": an unresolved component can
      // be exactly the one whose option values disappear on import.
      conclusive: !critical && !unresolvedCount,
      unresolved: unresolvedCount,
      summary: critical
        ? t('migration.verdict.critical', { count: critical, list: formatList(findings.filter((f) => f.severity === 'critical').map((f) => f.title), 3) })
        : unresolvedCount
          ? t('migration.verdict.inconclusive', { unresolved: unresolvedCount, missing: missingCount, shadowed: shadowedSolutions.length })
          : t('migration.verdict.safe', { missing: missingCount, shadowed: shadowedSolutions.length }),
      recommendation: critical
        ? t('migration.recommendation.critical')
        : unresolvedCount
          ? t('migration.recommendation.unresolved')
          : shadowedSolutions.length
            ? t('migration.recommendation.shadowed')
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
      unresolved: target.unresolved,
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
      unresolved: target.unresolved.length,
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
