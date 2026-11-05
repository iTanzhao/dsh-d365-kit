/**
 * Business-data migration between two environments.
 *
 * Two phases, like metadata writes: `plan` only reads and produces a report
 * that states volume, fields, lookup resolution and write options; `execute`
 * writes, and only after a person approved the confirmation card.
 *
 * Identity rules (the product owner's decisions, in order):
 *  - mirror is the default: the source GUID becomes the target GUID;
 *  - `keepGuid: false` is allowed when asked for; then lookups that point
 *    inside the batch are remapped to the ids the target assigned;
 *  - a lookup keeps its GUID when the target has that record, otherwise the
 *    referenced record is searched by primary name — never invented;
 *  - an existing target record with the same GUID is reported and left alone
 *    unless the caller explicitly asks for `conflict: overwrite`.
 *
 * The scope is never guessed: a caller must pass `fetchXml`, `filter`, `ids`,
 * or a `since` window. The tool answers with instructions otherwise.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { D365Error } from './errors.js'
import { dataRoot } from './snapshot.js'
import { makeClient, writeArtifact } from './runtime.js'
import { getPagedWithSelectFallback } from './client.js'
import { odataString } from './resources.js'

const LOOKUP_TYPES = new Set(['Lookup', 'Customer', 'Owner'])
const SIMPLE_TYPES = new Set([
  'String', 'Memo', 'Integer', 'BigInt', 'Decimal', 'Double', 'Money',
  'Boolean', 'DateTime', 'Picklist', 'State', 'Status', 'Uniqueidentifier',
  'MultiSelectPicklist',
])

/**
 * Attributes that describe bookkeeping rather than the record. `createdon` is
 * carried through `overriddencreatedon`, `modifiedon` cannot be written, and
 * the image columns are not record data.
 */
const SYSTEM_ATTRIBUTES = new Set([
  'createdby', 'createdonbehalfby', 'modifiedby', 'modifiedonbehalfby',
  'owningbusinessunit', 'owninguser', 'owningteam',
  'versionnumber', 'importsequencenumber',
  'timezoneruleversionnumber', 'utcconversiontimezonecode',
  'processid', 'stageid', 'traversedpath',
  'entityimage', 'entityimageid', 'entityimage_timestamp', 'entityimage_url',
  'createdon', 'modifiedon', 'overriddencreatedon',
])

const ID = /^[0-9A-Za-z-]{6,64}$/
const MAX_RECORDS = 5_000

export function plansDir(config) {
  return join(dataRoot(config), 'data-sync', 'plans')
}

export function runsDir(config) {
  return join(dataRoot(config), 'data-sync', 'runs')
}

function planPath(config, id) {
  return ID.test(String(id ?? '')) ? join(plansDir(config), `${id}.json`) : undefined
}

export async function saveMigrationPlan(config, plan) {
  const record = {
    ...plan,
    id: plan.id ?? randomUUID().slice(0, 12),
    createdAt: new Date().toISOString(),
    status: 'pending',
  }
  const dir = plansDir(config)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return record
}

export async function readMigrationPlan(config, id) {
  const path = planPath(config, id)
  if (!path) return undefined
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

export async function deleteMigrationPlan(config, id) {
  const path = planPath(config, id)
  if (!path) return false
  try {
    await rm(path)
    return true
  } catch {
    return false
  }
}

export async function listMigrationPlans(config) {
  const dir = plansDir(config)
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const plans = []
  for (const name of names.filter((item) => item.endsWith('.json'))) {
    const plan = await readMigrationPlan(config, name.replace(/\.json$/, ''))
    if (plan) plans.push(plan)
  }
  return plans.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

export async function setMigrationPlanStatus(config, id, status, extra = {}) {
  const plan = await readMigrationPlan(config, id)
  if (!plan) return undefined
  const next = { ...plan, ...extra, status, updatedAt: new Date().toISOString() }
  await writeFile(planPath(config, id), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

export async function readMigrationRuns(config, limit = 20) {
  const dir = runsDir(config)
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const runs = []
  for (const name of names.filter((item) => item.endsWith('.json')).sort().reverse().slice(0, limit)) {
    try {
      runs.push(JSON.parse(await readFile(join(dir, name), 'utf8')))
    } catch {
      // A half-written run file is skipped rather than failing the listing.
    }
  }
  return runs
}

// ---------------------------------------------------------------- metadata --

/** Chunk an array; OData `or` chains and request bodies both need a bound. */
function chunk(items, size) {
  const out = []
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size))
  return out
}

function envOf(config, key, label) {
  const env = config.environments[key]
  if (!env) {
    const available = Object.keys(config.environments).join(', ')
    throw new D365Error(`${label}环境不存在：${key || '（未指定）'}`, {
      code: 'unknown-environment',
      hint: `可用：${available}`,
    })
  }
  return env
}

/**
 * Read one entity's set name, primary id and primary name attribute.
 *
 * Accepts either the logical name (`account`) or the set name (`accounts`),
 * because both spellings appear in user requests.
 */
export async function readEntityInfo(client, entity, signal) {
  const candidate = String(entity ?? '').trim()
  if (!candidate) throw new D365Error('entity 不能为空', { code: 'missing-entity' })
  const select = 'LogicalName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute'

  const attempts = [
    `LogicalName eq '${odataString(candidate)}' or EntitySetName eq '${odataString(candidate)}'`,
    `LogicalName eq '${odataString(candidate)}'`,
  ]
  for (const filter of attempts) {
    try {
      const page = await getPagedWithSelectFallback(client, 'EntityDefinitions', { $select: select, $filter: filter }, 2, signal)
      const row = page?.page?.records?.[0]
      if (row) {
        return {
          logical: row.LogicalName,
          set: row.EntitySetName ?? `${row.LogicalName}s`,
          idField: row.PrimaryIdAttribute ?? `${row.LogicalName}id`,
          nameField: row.PrimaryNameAttribute,
        }
      }
    } catch (error) {
      // A rejected filter shape is worth one narrower retry; a 401 or a timeout
      // is not, and must surface as itself.
      if (error?.status !== 400) throw error
    }
  }
  throw new D365Error(`实体不存在：${candidate}`, {
    code: 'unknown-entity',
    hint: '传实体逻辑名（account）或集合名（accounts）；数据库里没有这张表的话，先确认它随解决方案导入到了该环境。',
  })
}

/** Read the attribute catalogue; `$top` is rejected by this endpoint. */
async function readAttributes(client, logical, signal) {
  const page = await getPagedWithSelectFallback(client, `EntityDefinitions(LogicalName='${odataString(logical)}')/Attributes`, {
    __noTop: true,
    $select: 'LogicalName,AttributeType,IsValidForCreate,IsValidForRead',
  }, Infinity, signal)
  const targets = await readLookupTargets(client, logical, signal)
  return (page?.page?.records ?? []).map((row) => ({
    name: row.LogicalName,
    type: row.AttributeType,
    writable: row.IsValidForCreate !== false,
    targets: targets.get(row.LogicalName) ?? [],
  }))
}

/**
 * Lookup targets live on `LookupAttributeMetadata`, not on the base
 * `AttributeMetadata` the collection returns: selecting `Targets` there fails
 * with 0x80060888 ("Could not find a property named 'Targets'"). One cast
 * request per entity gets the whole map, so each lookup knows which table(s) it
 * may point at.
 */
async function readLookupTargets(client, logical, signal) {
  const map = new Map()
  try {
    const page = await getPagedWithSelectFallback(
      client,
      `EntityDefinitions(LogicalName='${odataString(logical)}')/Attributes/Microsoft.Dynamics.CRM.LookupAttributeMetadata`,
      { __noTop: true, $select: 'LogicalName,Targets' },
      Infinity,
      signal,
    )
    for (const row of page?.page?.records ?? []) {
      if (row.LogicalName && Array.isArray(row.Targets) && row.Targets.length) map.set(row.LogicalName, row.Targets)
    }
  } catch (error) {
    // A shape this org will not serve is not fatal: lookups still resolve by
    // GUID, and the polymorphic case says so instead of guessing a table.
    if (error?.status === 401 || error?.status === 403) throw error
  }
  return map
}

/**
 * Which source columns travel. Explicit `fields` win; otherwise every writable
 * simple or lookup column except bookkeeping.
 */
export function chooseFields(attributes, options = {}) {
  const byName = new Map(attributes.map((attribute) => [attribute.name, attribute]))
  const requested = Array.isArray(options.fields) ? options.fields.map((item) => String(item).trim()).filter(Boolean) : []

  if (requested.length) {
    const unknown = requested.filter((name) => !byName.has(name))
    if (unknown.length) {
      throw new D365Error(`字段不存在：${unknown.join(', ')}`, {
        code: 'unknown-attribute',
        hint: `${options.entity ?? '该表'} 的可写字段里没有这些名字；先用 d365_metadata resource=attributes 核对逻辑名。`,
      })
    }
    const blocked = requested.filter((name) => {
      const attribute = byName.get(name)
      return !attribute.writable || SYSTEM_ATTRIBUTES.has(name) || name === 'ownerid'
    })
    if (blocked.length) {
      throw new D365Error(`字段不可写：${blocked.join(', ')}`, {
        code: 'readonly-attribute',
        hint: 'createdon/modifiedon/versionnumber 这类字段由平台维护；创建时间会被自动带到 overriddencreatedon。',
      })
    }
    return requested.map((name) => toPlanField(byName.get(name)))
  }

  const includeState = options.includeState === true
  return attributes
    .filter((attribute) => {
      if (SYSTEM_ATTRIBUTES.has(attribute.name)) return false
      if (attribute.name === 'ownerid') return false
      if (attribute.name === 'statecode' || attribute.name === 'statuscode') return includeState
      if (!attribute.writable) return false
      return SIMPLE_TYPES.has(attribute.type) || LOOKUP_TYPES.has(attribute.type)
    })
    .map(toPlanField)
}

function toPlanField(attribute) {
  return {
    name: attribute.name,
    type: attribute.type,
    lookup: LOOKUP_TYPES.has(attribute.type),
    targets: attribute.targets ?? [],
  }
}

// ------------------------------------------------------------------- scope --

/**
 * Turn the caller's scope into one OData filter, defaulting to the whole table.
 *
 * "Sync today's accounts" is a date window on createdon, "the ones I fixed" is
 * a filter, and a hand-written fetchXml is already exact. With no condition at
 * all the whole table is the documented default; the plan reports the volume so
 * a big table gets a recommendation to narrow it rather than a silent guess.
 */
export function describeScope(options = {}) {
  const fetchXml = typeof options.fetchXml === 'string' ? options.fetchXml.trim() : ''
  const filter = typeof options.filter === 'string' ? options.filter.trim() : ''
  const ids = Array.isArray(options.ids) ? options.ids.map((item) => String(item).trim()).filter(Boolean) : []
  const since = options.since === undefined || options.since === null || options.since === '' ? '' : String(options.since).trim()
  const mode = options.mode ?? 'new'

  if (fetchXml) {
    const entity = /<entity[^>]*\bname\s*=\s*["']([^"']+)["']/i.exec(fetchXml)?.[1]
    return { kind: 'fetchXml', fetchXml, filter: '', ids: [], since: '', mode, description: `fetchXml${entity ? `（${entity}）` : ''}` }
  }
  if (ids.length) {
    return { kind: 'ids', fetchXml: '', filter: '', ids, since: '', mode, description: `${ids.length} 个指定 GUID` }
  }
  if (since) {
    const date = new Date(since)
    if (Number.isNaN(date.getTime())) {
      throw new D365Error(`since 不是合法时间：${since}`, {
        code: 'bad-since',
        hint: '用 ISO 时间，例如 2026-11-05T00:00:00+08:00；不带时区会被当作 UTC。',
      })
    }
    const field = mode === 'modified' ? 'modifiedon' : 'createdon'
    const iso = date.toISOString()
    const composed = filter ? `(${filter}) and ${field} ge ${iso}` : `${field} ge ${iso}`
    return {
      kind: 'filter',
      fetchXml: '',
      filter: composed,
      ids: [],
      since: iso,
      mode,
      description: `${field} ge ${iso}${filter ? ` 且 ${filter}` : ''}`,
    }
  }
  if (filter) {
    return { kind: 'filter', fetchXml: '', filter, ids: [], since: '', mode, description: filter }
  }
  if (mode === 'all') {
    // "Everything" is a scope the caller can state on purpose; the record cap
    // then decides how much of it the plan actually covers, and the plan says so.
    return {
      kind: 'all',
      fetchXml: '',
      filter: '',
      ids: [],
      since: '',
      mode,
      description: '全部记录（没有时间条件，只受 maxRecords 限制）',
    }
  }
  // No condition at all: the documented default is the whole table. The plan
  // then reports the real volume and suggests a narrower scope when it is big,
  // instead of refusing or silently guessing what "today's" means.
  return {
    kind: 'all',
    fetchXml: '',
    filter: '',
    ids: [],
    since: '',
    mode: 'all',
    implicit: true,
    description: '全部记录（未指定条件，默认整表；受 maxRecords 限制）',
  }
}

/** Read the source rows for one scope. @returns `{ rows, hasMore }`. */
async function readRows(client, info, scope, fields, maxRecords, signal) {
  const lookupSelect = fields.filter((field) => field.lookup).map((field) => `_${field.name}_value`)
  const plainSelect = fields.filter((field) => !field.lookup).map((field) => field.name)
  const select = [...new Set([
    info.idField,
    ...plainSelect,
    ...lookupSelect,
    'createdon',
    'statecode',
    'statuscode',
    '_ownerid_value',
  ])].join(',')

  if (scope.kind === 'fetchXml') {
    const page = await client.getPaged(info.set, { fetchXml: scope.fetchXml }, maxRecords, signal)
    return { rows: page.records ?? [], hasMore: page.hasMore, select: null }
  }

  if (scope.kind === 'ids') {
    const rows = []
    for (const group of chunk(scope.ids, 20)) {
      if (rows.length >= maxRecords) break
      const filter = group.map((id) => `${info.idField} eq ${/^[0-9a-f-]{36}$/i.test(id) ? id : `'${odataString(id)}'`}`).join(' or ')
      const page = await client.getPaged(info.set, { $select: select, $filter: `(${filter})` }, maxRecords, signal)
      rows.push(...page.records.slice(0, maxRecords - rows.length))
    }
    return { rows, hasMore: false, select }
  }

  const params = { $select: select, $orderby: `${info.idField} asc` }
  if (scope.filter) params.$filter = scope.filter
  const page = await client.getPaged(info.set, params, maxRecords, signal)
  return { rows: page.records, hasMore: page.hasMore, select }
}

// ------------------------------------------------------- lookup resolution --

function singleKeyed(client, path, params, signal) {
  return client.requestJson(client.buildUrl(path, params), { signal })
}

async function tryKeyed(client, path, params, signal) {
  try {
    return await singleKeyed(client, path, params, signal)
  } catch (error) {
    if (error?.status === 404) return undefined
    throw error
  }
}

/**
 * The primary-name attribute of a referenced entity, resolved per environment
 * (a customised set name differs between orgs).
 */
async function entityInfoFor(client, logical, cache, signal) {
  const key = String(logical).toLowerCase()
  if (cache.entities.has(key)) return cache.entities.get(key)
  const info = await readEntityInfo(client, logical, signal).catch(() => null)
  cache.entities.set(key, info)
  return info
}

/** Names for a set of ids, chunked; missing rows are simply absent. */
async function readNames(client, info, field, ids, signal) {
  const names = new Map()
  if (!info?.nameField) return names
  for (const group of chunk(ids, 20)) {
    const filter = group.map((id) => `${info.idField} eq ${id}`).join(' or ')
    const page = await client.getPaged(info.set, { $select: `${info.idField},${info.nameField}`, $filter: `(${filter})` }, group.length + 1, signal)
    for (const row of page.records ?? []) names.set(String(row[info.idField]).toLowerCase(), row[info.nameField])
  }
  return names
}

/** Which of these ids already exist in the target. */
async function existingIds(client, info, ids, signal) {
  const found = new Set()
  for (const group of chunk(ids, 20)) {
    const filter = group.map((id) => `${info.idField} eq ${id}`).join(' or ')
    const page = await client.getPaged(info.set, { $select: info.idField, $filter: `(${filter})` }, group.length + 1, signal)
    for (const row of page.records ?? []) found.add(String(row[info.idField]).toLowerCase())
  }
  return found
}

/** Exact primary-name match in the target; `>=2` hits are ambiguous, not a match. */
async function findByName(client, info, name, signal) {
  if (!info?.nameField || name === undefined || name === null || String(name).trim() === '') return { matches: [] }
  const page = await client.getPaged(info.set, {
    $select: `${info.idField},${info.nameField}`,
    $filter: `${info.nameField} eq '${odataString(String(name))}'`,
  }, 3, signal)
  return { matches: page.records ?? [] }
}

/**
 * Which entity actually holds each id in the source.
 *
 * `customerid` and `ownerid` point at more than one table, and matching a
 * contact's name against accounts because the account lookup happened to be
 * tried first would silently attach the wrong record. The owning table is
 * therefore read from the source, not guessed from the attribute's Targets.
 */
async function typeOfIds(client, candidates, ids, signal) {
  const found = new Map()
  const pending = () => ids.filter((id) => !found.has(id.toLowerCase()))
  for (const logical of candidates) {
    if (!pending().length) break
    const info = await readEntityInfo(client, logical, signal).catch(() => null)
    if (!info) continue
    for (const group of chunk(pending(), 20)) {
      const filter = group.map((id) => `${info.idField} eq ${id}`).join(' or ')
      const page = await client.getPaged(info.set, { $select: info.idField, $filter: `(${filter})` }, group.length + 1, signal)
      for (const row of page.records ?? []) found.set(String(row[info.idField]).toLowerCase(), logical)
    }
  }
  return found
}

/**
 * Resolve every lookup value of every row against the target.
 *
 * Resolution order is fixed: same GUID, then primary-name match, then missing.
 * Nothing is written here; the plan only records what would happen.
 */
async function resolveLookups(sourceClient, targetClient, sourceCache, targetCache, rows, fields, options, signal) {
  const lookups = fields.filter((field) => field.lookup)
  /** key `${rowId}|${attribute}` -> resolution, plus `*|attr|id` for the shared lookups */
  const results = new Map()
  const summary = []

  for (const field of lookups) {
    const values = new Map()
    for (const row of rows) {
      const value = row[`_${field.name}_value`]
      if (value) values.set(String(row[sourceCache.info.idField]), String(value))
    }
    const entry = {
      attribute: field.name,
      targets: field.targets,
      filled: values.size,
      sameGuid: 0,
      byName: 0,
      missing: 0,
      ambiguous: 0,
      empty: rows.length - values.size,
      missingSamples: [],
    }
    if (!values.size) {
      summary.push(entry)
      continue
    }

    const distinct = [...new Set(values.values())]
    const single = field.targets.length === 1 ? field.targets[0] : null
    const types = single
      ? new Map(distinct.map((id) => [id.toLowerCase(), single]))
      : await typeOfIds(sourceClient, field.targets, distinct, signal)

    // Group by the table that owns the value, so each id is resolved once.
    const groups = new Map()
    for (const id of distinct) {
      const logical = types.get(id.toLowerCase())
      if (!logical) {
        const reason = field.targets.length
          ? '源环境里找不到这条被引用记录（可能已被删除）'
          : '元数据没有给出这个 lookup 的目标表，无法判断它指向哪张表'
        results.set(`*|${field.name}|${id}`, { how: 'missing', sourceId: id, reason })
        continue
      }
      if (!groups.has(logical)) groups.set(logical, [])
      groups.get(logical).push(id)
    }

    for (const [logical, ids] of groups) {
      const sourceInfo = await entityInfoFor(sourceClient, logical, sourceCache, signal)
      const targetInfo = await entityInfoFor(targetClient, logical, targetCache, signal)
      if (!sourceInfo || !targetInfo) {
        for (const id of ids) {
          results.set(`*|${field.name}|${id}`, { how: 'missing', sourceId: id, reason: `目标环境没有 ${logical} 这张表` })
        }
        continue
      }

      const names = options.resolveLookups === false ? new Map() : await readNames(sourceClient, sourceInfo, sourceInfo.idField, ids, signal)
      const present = await existingIds(targetClient, targetInfo, ids, signal)

      for (const id of ids) {
        if (present.has(id.toLowerCase())) {
          // Same GUID in both orgs: a mirror-copy can carry the value as-is.
          results.set(`*|${field.name}|${id}`, { how: 'same-guid', targetId: id, targetSet: targetInfo.set, sourceId: id, name: names.get(id.toLowerCase()) })
          continue
        }
        const name = names.get(id.toLowerCase())
        if (!name || options.resolveLookups === false) {
          results.set(`*|${field.name}|${id}`, {
            how: 'missing',
            sourceId: id,
            name,
            reason: options.resolveLookups === false ? '本次关闭了 lookup 名称解析（includeLookups=false）' : '源环境读不到该引用的名称',
          })
          continue
        }
        const found = await findByName(targetClient, targetInfo, name, signal)
        if (found.matches.length === 1) {
          results.set(`*|${field.name}|${id}`, {
            how: 'by-name',
            targetId: String(found.matches[0][targetInfo.idField]),
            targetSet: targetInfo.set,
            sourceId: id,
            name,
          })
        } else if (found.matches.length > 1) {
          results.set(`*|${field.name}|${id}`, { how: 'ambiguous', sourceId: id, name, reason: `目标里同名 ${logical} 有 ${found.matches.length} 条` })
        } else {
          results.set(`*|${field.name}|${id}`, { how: 'missing', sourceId: id, name, reason: `目标里按名称找不到对应的 ${logical}` })
        }
      }
    }

    for (const row of rows) {
      const rowId = String(row[sourceCache.info.idField])
      const value = values.get(rowId)
      if (!value) {
        results.set(`${rowId}|${field.name}`, { how: 'empty' })
        continue
      }
      const resolution = results.get(`*|${field.name}|${value}`) ?? { how: 'missing', sourceId: value, reason: '未能解析' }
      results.set(`${rowId}|${field.name}`, resolution)
      if (resolution.how === 'same-guid') entry.sameGuid += 1
      else if (resolution.how === 'by-name') entry.byName += 1
      else if (resolution.how === 'ambiguous') {
        entry.ambiguous += 1
        if (entry.missingSamples.length < 5) entry.missingSamples.push({ sourceId: value, name: resolution.name, reason: resolution.reason })
      } else if (resolution.how === 'missing') {
        entry.missing += 1
        if (entry.missingSamples.length < 5) entry.missingSamples.push({ sourceId: value, name: resolution.name, reason: resolution.reason })
      }
    }
    summary.push(entry)
  }

  return { results, summary }
}

// ------------------------------------------------------------------ owners --

/** Who owned the record in the source, and who should own it in the target. */
async function resolveOwners(sourceClient, targetClient, rows, options, signal) {
  const ownerIds = [...new Set(rows.map((row) => row._ownerid_value).filter(Boolean).map(String))]
  const map = new Map()
  let mapped = 0
  let fallback = 0

  for (const id of ownerIds) {
    const user = await tryKeyed(sourceClient, `systemusers(${id})`, { $select: 'domainname,internalemailaddress,fullname' }, signal)
    const team = user ? undefined : await tryKeyed(sourceClient, `teams(${id})`, { $select: 'name,emailaddress' }, signal)
    if (!user && !team) {
      map.set(id, { how: 'unknown', sourceId: id })
      continue
    }
    if (options.ownerMode === 'keep') {
      map.set(id, { how: 'keep', sourceId: id, targetId: id, set: user ? 'systemusers' : 'teams' })
      continue
    }
    if (options.ownerMode === 'caller') {
      map.set(id, { how: 'caller', sourceId: id })
      fallback += 1
      continue
    }
    const key = user ? (user.domainname ?? user.internalemailaddress) : (team.emailaddress ?? team.name)
    let hit
    if (user && key) {
      const page = await targetClient.getPaged('systemusers', {
        $select: 'systemuserid,domainname',
        $filter: `domainname eq '${odataString(String(key))}' or internalemailaddress eq '${odataString(String(key))}'`,
      }, 2, signal)
      hit = page.records?.[0]
      if (hit) map.set(id, { how: 'mapped', sourceId: id, targetId: hit.systemuserid, set: 'systemusers', key })
    } else if (team && key) {
      const page = await targetClient.getPaged('teams', {
        $select: 'teamid,name',
        $filter: `name eq '${odataString(String(key))}'`,
      }, 2, signal)
      hit = page.records?.[0]
      if (hit) map.set(id, { how: 'mapped', sourceId: id, targetId: hit.teamid, set: 'teams', key })
    }
    if (hit) {
      mapped += 1
    } else {
      map.set(id, { how: 'fallback', sourceId: id, key: key ?? id })
      fallback += 1
    }
  }

  return { map, distinct: ownerIds.length, mapped, fallback }
}

// -------------------------------------------------------------------- plan --

function numberArg(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

/**
 * Build a migration plan. Reads both environments; writes nothing.
 */
export async function buildPlan(config, args = {}, signal) {
  const sourceKey = String(args.source ?? '').trim()
  const targetKey = String(args.target ?? '').trim()
  if (!sourceKey || !targetKey) {
    throw new D365Error('需要 source 和 target', {
      code: 'missing-environment',
      hint: `例如 source="dev" target="sit"；可用：${Object.keys(config.environments).join(', ')}`,
    })
  }
  if (sourceKey === targetKey) {
    throw new D365Error('source 和 target 是同一个环境', { code: 'same-environment', hint: '迁移的两个环境必须不同。' })
  }
  const sourceEnv = envOf(config, sourceKey, '源')
  const targetEnv = envOf(config, targetKey, '目标')
  const sourceClient = makeClient(sourceEnv, config)
  const targetClient = makeClient(targetEnv, config)

  const scope = describeScope(args)
  const maxRecords = numberArg(args.maxRecords, 500, 1, MAX_RECORDS)
  const options = {
    keepGuid: true,
    resolveLookups: args.includeLookups !== false,
    ownerMode: ['map', 'keep', 'caller'].includes(args.ownerMode) ? args.ownerMode : 'map',
    conflict: ['report', 'skip', 'overwrite'].includes(args.conflict) ? args.conflict : 'report',
    onMissingLookup: ['report', 'null', 'fail'].includes(args.onMissingLookup) ? args.onMissingLookup : 'report',
    bypassPlugins: args.bypassPlugins !== false,
    preserveCreatedOn: args.preserveCreatedOn !== false,
    suppressDuplicateDetection: args.suppressDuplicateDetection !== false,
    includeState: args.includeState === true,
    concurrency: numberArg(args.concurrency, 4, 1, 8),
    batchSize: numberArg(args.batchSize, 50, 10, 500),
  }

  const sourceCache = { info: await readEntityInfo(sourceClient, args.entity, signal), entities: new Map() }
  const targetCache = { info: await readEntityInfo(targetClient, args.entity, signal), entities: new Map() }
  sourceCache.info.attributes = await readAttributes(sourceClient, sourceCache.info.logical, signal)

  const fields = chooseFields(sourceCache.info.attributes, {
    fields: args.fields,
    includeState: options.includeState,
    entity: sourceCache.info.logical,
  })
  if (!fields.length) {
    throw new D365Error('没有可迁移的字段', { code: 'no-fields', hint: '该表除系统字段外没有可写列；用 fields 显式指定要看/要搬的列。' })
  }

  // Keeping the source GUID is not a separate toggle to guess at: it follows the
  // field list. A field list that carries the primary key mirrors the record
  // (same GUID); one that leaves it out lets the target assign a new id, and the
  // references inside the batch are remapped. An explicit keepGuid still wins.
  const explicitKeepGuid = typeof args.keepGuid === 'boolean' ? args.keepGuid : undefined
  const carriesId = fields.some((field) => field.name === sourceCache.info.idField)
  options.keepGuid = explicitKeepGuid ?? carriesId
  options.keepGuidBecause = explicitKeepGuid !== undefined
    ? 'explicit'
    : carriesId ? 'id-in-fields' : 'no-id-in-fields'

  const { rows, hasMore, select } = await readRows(sourceClient, sourceCache.info, scope, fields, maxRecords, signal)
  // `hasMore` is reported, never silently dropped: the cap is a guard rail, and
  // the plan says how much it read so a truncated scope cannot look complete.
  const warnings = []
  if (scope.implicit) {
    warnings.push(`没有给迁移条件，按全部记录预演；读到 ${rows.length} 条${hasMore ? '（已到上限，还有更多）' : ''}。`
      + '数据量大时建议用 since / filter / ids / fetchXml 缩小范围。')
  }
  if (hasMore) {
    warnings.push(`只读了前 ${rows.length} 条（上限 ${maxRecords}），其余未纳入本次计划；要么调大 maxRecords，要么加条件分批迁。`)
  }
  const ids = rows.map((row) => String(row[sourceCache.info.idField]))
  const existing = options.keepGuid ? await existingIds(targetClient, targetCache.info, ids, signal) : new Set()
  const { results, summary: lookupSummary } = await resolveLookups(
    sourceClient, targetClient, sourceCache, targetCache, rows, fields, options, signal,
  )
  const owners = await resolveOwners(sourceClient, targetClient, rows, options, signal)

  const records = rows.map((row) => {
    const id = String(row[sourceCache.info.idField])
    const values = {}
    const lookups = []
    for (const field of fields) {
      if (field.lookup) {
        const resolution = results.get(`${id}|${field.name}`) ?? { how: 'empty' }
        lookups.push({ attribute: field.name, ...resolution })
        if (resolution.how === 'same-guid' || resolution.how === 'by-name') values[field.name] = resolution.targetId
        else if (resolution.how === 'empty') values[field.name] = null
        else if (options.onMissingLookup === 'null') values[field.name] = null
        continue
      }
      if (row[field.name] !== undefined) values[field.name] = row[field.name]
    }
    const owner = row._ownerid_value ? owners.map.get(String(row._ownerid_value)) : undefined
    return {
      id,
      action: existing.has(id.toLowerCase()) ? 'conflict' : 'create',
      name: sourceCache.info.nameField ? row[sourceCache.info.nameField] : undefined,
      createdon: row.createdon,
      statecode: row.statecode,
      statuscode: row.statuscode,
      values,
      lookups,
      owner,
      blocked: lookups.some((lookup) => lookup.how === 'missing' || lookup.how === 'ambiguous') && options.onMissingLookup === 'report',
    }
  })

  const conflicts = records.filter((record) => record.action === 'conflict').length
  const blocked = records.filter((record) => record.blocked).length
  const missing = lookupSummary.reduce((sum, entry) => sum + entry.missing + entry.ambiguous, 0)

  return {
    kind: 'data-sync',
    source: { key: sourceKey, url: sourceEnv.url, entity: sourceCache.info.logical, set: sourceCache.info.set },
    target: { key: targetKey, url: targetEnv.url, entity: targetCache.info.logical, set: targetCache.info.set },
    scope: { ...scope, description: scope.description, select },
    options,
    fields,
    idField: sourceCache.info.idField,
    limits: { maxRecords, read: rows.length, hasMore },
    warnings,
    lookupSummary,
    owners: { distinct: owners.distinct, mapped: owners.mapped, fallback: owners.fallback },
    counts: {
      read: rows.length,
      create: records.filter((record) => record.action === 'create').length,
      conflict: conflicts,
      blocked,
      missingLookups: missing,
    },
    records,
  }
}

// ----------------------------------------------------------------- execute --

/** Run `worker` over `items` with a bounded number of in-flight requests. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let index = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index
      index += 1
      results[current] = await worker(items[current], current)
    }
  })
  await Promise.all(runners)
  return results
}

/** Which lookups point at another record in the same batch (only matters without GUIDs). */
function dependencyOrder(records) {
  const bySource = new Map(records.map((record) => [record.id.toLowerCase(), record]))
  const edges = new Map()
  for (const record of records) {
    const needs = new Set()
    for (const lookup of record.lookups) {
      if (lookup.how === 'same-guid' && bySource.has(String(lookup.sourceId).toLowerCase())) needs.add(String(lookup.sourceId).toLowerCase())
    }
    edges.set(record.id.toLowerCase(), needs)
  }
  const ordered = []
  const temporary = new Set()
  const permanent = new Set()
  const visit = (id) => {
    if (permanent.has(id)) return
    if (temporary.has(id)) return // cycle: broken by deferring the lookup, handled later
    temporary.add(id)
    for (const dependency of edges.get(id) ?? []) visit(dependency)
    temporary.delete(id)
    permanent.add(id)
    ordered.push(bySource.get(id))
  }
  for (const record of records) visit(record.id.toLowerCase())
  return ordered
}

function writeHeaders(options) {
  const headers = { Prefer: 'return=representation' }
  if (options.suppressDuplicateDetection) headers['MSCRM.SuppressDuplicateDetection'] = 'true'
  if (options.bypassPlugins) headers['MSCRM.BypassCustomPluginExecution'] = 'true'
  return headers
}

/**
 * Point a lookup at a record.
 *
 * Dataverse's Web API treats a lookup as a navigation property, not a column: a
 * bare GUID (`"contoso_bg": "<guid>"`) is rejected with 0x80048d19 "a 'PrimitiveValue'
 * node with non-null value was found ... a 'PrimitiveValue' node with null value
 * was expected". The value has to travel as `"contoso_bg@odata.bind": "/set(id)"`.
 */
function bindLookup(body, attribute, set, id) {
  delete body[attribute]
  if (!set) return false
  body[`${attribute}@odata.bind`] = `/${set}(${id})`
  return true
}

function buildBody(record, info, options) {
  const body = { ...record.values }
  // The primary key only travels through the keepGuid decision: a source GUID
  // left in `values` would make the target reject the create (or worse, collide
  // with a record copied earlier).
  delete body[info.idField]
  if (options.keepGuid) body[info.idField] = record.id
  if (options.preserveCreatedOn && record.createdon) body.overriddencreatedon = record.createdon
  if (options.includeState === false) {
    delete body.statecode
    delete body.statuscode
  }
  // A null lookup stays a literal null (the API accepts that for a navigation
  // property); a resolved one becomes an @odata.bind annotation.
  for (const lookup of record.lookups ?? []) {
    const value = body[lookup.attribute]
    if (value !== null && value !== undefined) bindLookup(body, lookup.attribute, lookup.targetSet, value)
  }
  const owner = record.owner
  if (owner && options.ownerMode !== 'caller') {
    if (owner.how === 'mapped' || owner.how === 'keep') {
      bindLookup(body, 'ownerid', owner.set ?? 'systemusers', owner.targetId)
    }
  }
  return body
}

/**
 * Execute an approved plan.
 *
 * `hooks.onRecord` is called after each record settles so a caller can record
 * progress; the run file is the durable copy.
 */
export async function executeMigration(config, plan, options = {}, signal, hooks = {}) {
  const planOptions = { ...plan.options, ...options }
  const targetEnv = envOf(config, plan.target.key, '目标')
  // `targetClient` lets a test drive the write path without an org behind it.
  const targetClient = hooks.targetClient ?? makeClient(targetEnv, config)
  const targetInfo = await readEntityInfo(targetClient, plan.target.entity, signal)

  if (planOptions.onMissingLookup === 'fail') {
    const blocked = plan.records.filter((record) => record.blocked)
    if (blocked.length) {
      throw new D365Error(`有 ${blocked.length} 条记录的引用在目标环境找不到`, {
        code: 'missing-lookup',
        hint: '把 onMissingLookup 改成 report（跳过这些记录）或 null（清空这些引用），或先在目标环境补齐被引用记录。',
      })
    }
  }

  const runId = `run-${plan.id}-${randomUUID().slice(0, 6)}`
  const runFile = join(runsDir(config), `${new Date().toISOString().replace(/[:.]/g, '-')}-${runId}.json`)
  await mkdir(runsDir(config), { recursive: true })

  const writable = plan.records.filter((record) => {
    if (record.action === 'conflict' && planOptions.conflict !== 'overwrite') return false
    if (record.blocked && planOptions.onMissingLookup === 'report') return false
    return true
  })
  const skipped = plan.records.length - writable.length

  // Without GUIDs the target assigns ids, so lookups inside the batch must be
  // remapped after the create. Ordering keeps referenced records first.
  const ordered = planOptions.keepGuid ? writable : dependencyOrder(writable)
  const idMap = new Map()

  const results = await mapLimit(ordered, planOptions.concurrency ?? 4, async (record) => {
    const body = buildBody(record, targetInfo, planOptions)
    // A lookup that points at a batch member whose new id is not known yet is
    // sent later, in a second PATCH pass.
    const deferred = []
    if (!planOptions.keepGuid) {
      for (const lookup of record.lookups) {
        if (lookup.how !== 'same-guid') continue
        const mapped = idMap.get(String(lookup.sourceId).toLowerCase())
        if (mapped) {
          bindLookup(body, lookup.attribute, lookup.targetSet, mapped)
        } else {
          delete body[lookup.attribute]
          delete body[`${lookup.attribute}@odata.bind`]
          deferred.push(lookup.attribute)
        }
      }
    }
    try {
      if (record.action === 'conflict') {
        await targetClient.sendJson(`${targetInfo.set}(${record.id})`, {
          method: 'PATCH',
          body,
          headers: { ...writeHeaders(planOptions), 'If-Match': '*' },
        }, signal)
        return { id: record.id, action: 'updated', deferred }
      }
      const created = await targetClient.sendJson(targetInfo.set, {
        method: 'POST',
        body,
        headers: writeHeaders(planOptions),
      }, signal)
      const newId = created?.[targetInfo.idField] ?? record.id
      idMap.set(record.id.toLowerCase(), String(newId))
      return { id: record.id, targetId: String(newId), action: 'created', deferred, values: body }
    } catch (error) {
      return { id: record.id, action: 'failed', error: String(error?.message ?? error), code: error?.code, status: error?.status }
    }
  })

  // Second pass: lookups that pointed at records created later in this run.
  const deferredRecords = ordered
    .map((record, index) => ({ record, result: results[index] }))
    .filter((entry) => entry.result?.action !== 'failed' && entry.result?.deferred?.length)
  for (const entry of deferredRecords) {
    const body = {}
    for (const attribute of entry.result.deferred) {
      const lookup = entry.record.lookups.find((item) => item.attribute === attribute)
      const mapped = lookup ? idMap.get(String(lookup.sourceId).toLowerCase()) : undefined
      if (mapped) bindLookup(body, attribute, lookup.targetSet, mapped)
    }
    if (!Object.keys(body).length) continue
    try {
      await targetClient.sendJson(`${targetInfo.set}(${entry.result.targetId ?? entry.record.id})`, {
        method: 'PATCH',
        body,
        headers: { ...writeHeaders(planOptions), 'If-Match': '*' },
      }, signal)
    } catch (error) {
      entry.result.deferredError = String(error?.message ?? error)
    }
  }

  const created = results.filter((item) => item.action === 'created')
  const updated = results.filter((item) => item.action === 'updated')
  const failed = results.filter((item) => item.action === 'failed')
  const run = {
    kind: 'data-sync-run',
    runId,
    planId: plan.id,
    at: new Date().toISOString(),
    source: plan.source,
    target: plan.target,
    options: planOptions,
    counts: { planned: plan.records.length, written: created.length + updated.length, skipped, failed: failed.length },
    created: created.map((item) => ({ sourceId: item.id, targetId: item.targetId })),
    updated: updated.map((item) => item.id),
    failures: failed,
    skippedRecords: plan.records
      .filter((record) => !writable.includes(record))
      .map((record) => ({
        id: record.id,
        reason: record.action === 'conflict' ? '目标已存在同 GUID，按 conflict=report 跳过' : '引用缺失，按 onMissingLookup=report 跳过',
      })),
  }
  await writeFile(runFile, `${JSON.stringify(run, null, 2)}\n`, 'utf8')
  hooks.onRecord?.(run)
  run.file = runFile
  return run
}

/** Write the plan itself as an artifact, so the full record list survives. */
export async function writePlanArtifact(config, plan) {
  return writeArtifact(config, `data-sync-${plan.source.key}-${plan.target.key}`, plan)
}
