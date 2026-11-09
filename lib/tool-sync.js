/**
 * `d365_sync` — pull a fixed metadata set into a local snapshot.
 *
 * Snapshots exist so that "what changed" is answerable without keeping the
 * live environment as the only source of truth. Each sync is a full pull (the
 * Dataverse metadata API has no delta for most tables); the value is not fewer
 * requests but a durable, comparable record with an honest completeness report.
 */
import { loadConfig } from './config.js'
import { makeClient, pickEnvironments, readOrganization } from './runtime.js'
import { RESOURCES, composeFilter, flattenLabels, odataString } from './resources.js'
import { getPagedWithSelectFallback } from './client.js'
import { D365Error } from './errors.js'
import { ensureDataRoot, pruneSnapshots, snapshotId, writeSnapshot } from './snapshot.js'
import { enforceRetention } from './retention.js'

/**
 * The default pull set. Deliberately excludes `attributes` (one request per
 * entity) and skips the resources that need per-entity iteration; ask for those
 * explicitly with `includeAttributes`.
 */
export const CORE_RESOURCES = [
  'organization',
  'solutions',
  'solution_components',
  'entities',
  'forms',
  'views',
  'workflows',
  'plugin_assemblies',
  'plugin_types',
  'plugin_steps',
  'web_resources',
  'custom_apis',
  'sitemaps',
  'option_sets',
]

/** Entities whose attributes are pulled when `includeAttributes` is set. */
const MAX_ATTRIBUTE_ENTITIES = 500

export const definition = {
  name: 'd365_sync',
  description:
    '把一个或多个环境的 D365 CE 元数据拉成本地快照（写到 .d365/snapshots/<env>/<快照ID>/），并记录每个资源是完整、被行数上限截断，还是失败。'
    + '快照是 d365_diff 的输入；数据源是实时 Web API，元数据表大多没有增量游标，所以每次都是全量拉取。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      environments: {
        type: 'array',
        items: { type: 'string' },
        description: '环境 key 列表，例如 ["dev","sit"]。省略则用默认环境。',
      },
      allEnvironments: {
        type: 'boolean',
        description: '同步全部已配置环境。',
      },
      resources: {
        type: 'array',
        items: { type: 'string', enum: Object.keys(RESOURCES) },
        description: '只同步指定资源，默认是一组核心资源（不含 attributes）。',
      },
      includeAttributes: {
        type: 'boolean',
        description: '额外拉取每个实体的字段定义。请求数约为实体数，耗时明显更长。',
      },
      entities: {
        type: 'array',
        items: { type: 'string' },
        description: '配合 includeAttributes：只拉这些实体的字段（如 ["account","new_order"]）。',
      },
      maxRecords: {
        type: 'integer',
        description: '每个资源最多拉多少行。默认 0，表示全量分页拉完；填正数则限制行数（被截断的资源会在 manifest 里标出）。',
      },
      keep: {
        type: 'integer',
        description: '每个环境保留多少份快照，超出后删除最旧的，默认取配置 snapshotKeep（2）。',
      },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string' },
      },
    },
    render(_args, value) {
      return [{ type: 'text', text: value?.text ?? '' }]
    },
  },
}

/** Run at most `limit` workers over `items`, keeping result order. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/** Build and execute one resource request. */
async function fetchResource(client, resource, options) {
  const def = RESOURCES[resource]
  const path = resource === 'attributes'
    ? `EntityDefinitions(LogicalName='${odataString(options.entity)}')/Attributes`
    : def.path({ entity: options.entity })
  const params = {
    $select: def.select,
    $filter: composeFilter(def, { entity: options.entity }),
    $orderby: def.orderby,
  }
  const { page } = await getPagedWithSelectFallback(client, path, params, options.top, options.signal)
  return page
}

/** Fetch attributes for many entities, a few at a time. */
async function fetchAttributes(client, entityNames, top, signal) {
  const rows = []
  const failures = []
  const started = Date.now()

  await mapLimit(entityNames, 4, async (entity) => {
    try {
      const page = await fetchResource(client, 'attributes', { entity, top, signal })
      for (const row of page.records) rows.push({ entity, ...flattenLabels(row) })
    } catch (error) {
      failures.push({ entity, message: error.message })
    }
  })

  return { rows, failures, elapsedMs: Date.now() - started }
}

/** Sync one environment and return its summary. */
async function syncEnvironment(env, config, args, exec) {
  const client = makeClient(env, config)
  const startedAt = new Date()
  const id = snapshotId(startedAt)
  const requestedAll = Array.isArray(args.resources) && args.resources.length
    ? [...new Set(args.resources)]
    : [...CORE_RESOURCES]
  const unknown = requestedAll.filter((resource) => !RESOURCES[resource])
  if (unknown.length) {
    throw new D365Error(`未知的资源：${unknown.join(', ')}`, {
      code: 'unknown-resource',
      hint: `可用：${Object.keys(RESOURCES).join(', ')}`,
    })
  }

  // Unlimited by default: a snapshot with rows silently missing is worse than a
  // slow sync, and `d365_diff` would report the missing rows as deletions.
  const maxRecords = args.maxRecords === undefined || args.maxRecords === 0
    ? Number.POSITIVE_INFINITY
    : Number.isFinite(args.maxRecords) && args.maxRecords > 0
      ? Math.min(1_000_000, Math.trunc(args.maxRecords))
      : Math.max(20_000, config.maxRecords)

  const organizationRow = flattenLabels(await readOrganization(client))

  const requested = requestedAll.filter((resource) => resource !== 'organization')
  const wantAttributes = args.includeAttributes === true
  const explicitEntities = Array.isArray(args.entities)
    ? args.entities.map((item) => String(item).trim()).filter(Boolean)
    : []

  const details = {}
  const files = []
  const issues = []
  let entitiesRows = null
  let entitiesTruncated = false

  // `keys` / `*_relationships` only make sense for one entity, and the loop
  // below has no entity argument: without this the path becomes
  // EntityDefinitions(LogicalName='undefined') and the resource fails.
  const withoutEntity = requested.filter((resource) => RESOURCES[resource]?.entityScoped && !explicitEntities.length)
  for (const resource of withoutEntity) {
    issues.push({ resource, message: '跳过：该资源需要实体（传 entities，或改用 d365_metadata 的 entity 参数）' })
  }

  if (organizationRow) {
    files.push({
      resource: 'organization',
      payload: {
        resource: 'organization',
        env: env.key,
        snapshotId: id,
        generatedAt: startedAt.toISOString(),
        count: 1,
        truncated: false,
        rows: [organizationRow],
      },
    })
    details.organization = { count: 1, truncated: false, requests: 1, elapsedMs: 0 }
  }

  // `entities` first: it is both a requested resource and the input to the
  // attribute walk, so a truncation here changes what the attribute pull covers.
  if (requested.includes('entities') || wantAttributes) {
    const started = Date.now()
    const before = client.counters.requests
    try {
      const page = await fetchResource(client, 'entities', { top: maxRecords, signal: exec?.signal })
      entitiesRows = page.records.map((row) => flattenLabels(row))
      entitiesTruncated = page.hasMore
      if (requested.includes('entities')) {
        files.push({
          resource: 'entities',
          payload: {
            resource: 'entities',
            env: env.key,
            snapshotId: id,
            generatedAt: new Date().toISOString(),
            count: entitiesRows.length,
            truncated: page.hasMore,
            rows: entitiesRows,
          },
        })
      }
      details.entities = {
        count: entitiesRows.length,
        truncated: page.hasMore,
        requests: client.counters.requests - before,
        elapsedMs: Date.now() - started,
      }
      if (page.hasMore) {
        issues.push({ resource: 'entities', message: `达到行数上限 ${maxRecords}，实体列表不完整，依赖它的字段采集也受限` })
      }
    } catch (error) {
      issues.push({ resource: 'entities', message: error.message })
      details.entities = { count: 0, truncated: true, requests: client.counters.requests - before, elapsedMs: Date.now() - started, error: error.message }
    }
  }

  for (const resource of requested) {
    if (resource === 'entities') continue
    if (withoutEntity.includes(resource)) continue
    const started = Date.now()
    const before = client.counters.requests
    try {
      const page = await fetchResource(client, resource, { top: maxRecords, signal: exec?.signal })
      const rows = page.records.map((row) => flattenLabels(row))
      files.push({
        resource,
        payload: {
          resource,
          env: env.key,
          snapshotId: id,
          generatedAt: new Date().toISOString(),
          count: rows.length,
          truncated: page.hasMore,
          rows,
        },
      })
      details[resource] = {
        count: rows.length,
        truncated: page.hasMore,
        requests: client.counters.requests - before,
        elapsedMs: Date.now() - started,
      }
      if (page.hasMore) {
        issues.push({ resource, message: `达到行数上限 ${maxRecords}，该资源不完整` })
      }
    } catch (error) {
      details[resource] = {
        count: 0,
        truncated: true,
        requests: client.counters.requests - before,
        elapsedMs: Date.now() - started,
        error: error.message,
      }
      issues.push({ resource, message: error.message })
    }
  }

  if (wantAttributes) {
    const available = entitiesRows ?? []
    const names = (explicitEntities.length ? explicitEntities : available.map((row) => row.LogicalName))
      .filter((name) => typeof name === 'string' && name.trim())
    const capped = names.slice(0, MAX_ATTRIBUTE_ENTITIES)
    if (names.length > capped.length) {
      issues.push({ resource: 'attributes', message: `实体数超过 ${MAX_ATTRIBUTE_ENTITIES}，只采集了前 ${MAX_ATTRIBUTE_ENTITIES} 个实体的字段` })
    }

    const started = Date.now()
    const result = await fetchAttributes(client, capped, maxRecords, exec?.signal)
    files.push({
      resource: 'attributes',
      payload: {
        resource: 'attributes',
        env: env.key,
        snapshotId: id,
        generatedAt: new Date().toISOString(),
        count: result.rows.length,
        truncated: entitiesTruncated || names.length > capped.length || result.failures.length > 0,
        entities: capped.length,
        failures: result.failures,
        rows: result.rows,
      },
    })
    details.attributes = {
      count: result.rows.length,
      truncated: entitiesTruncated || names.length > capped.length || result.failures.length > 0,
      entities: capped.length,
      failedEntities: result.failures.length,
      elapsedMs: result.elapsedMs,
    }
    for (const failure of result.failures.slice(0, 10)) {
      issues.push({ resource: `attributes:${failure.entity}`, message: failure.message })
    }
    if (result.failures.length > 10) {
      issues.push({ resource: 'attributes', message: `另有 ${result.failures.length - 10} 个实体的字段采集失败` })
    }
  }

  const finishedAt = new Date()
  const manifest = {
    snapshotId: id,
    env: env.key,
    label: env.label,
    url: env.url,
    organization: organizationRow
      ? {
          organizationid: organizationRow.organizationid,
          name: organizationRow.name,
          version: organizationRow.version,
          organizationstructure: organizationRow.organizationstructure,
        }
      : null,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - startedAt,
    complete: issues.length === 0,
    issues,
    resources: details,
    requested: ['organization', ...requested, ...(wantAttributes ? ['attributes'] : [])],
  }

  await ensureDataRoot(config)
  const dir = await writeSnapshot(config, env.key, id, manifest, files)
  const keep = Number.isFinite(args.keep) && args.keep > 0 ? Math.trunc(args.keep) : config.snapshotKeep
  const pruned = await pruneSnapshots(config, env.key, keep)
  await enforceRetention(config, { target: 'snapshots' })

  return { env, id, dir, manifest, pruned, organization: organizationRow }
}

/** Render one environment's sync summary. */
function renderSummary(result, config) {
  const { env, manifest } = result
  const lines = []
  const orgName = manifest.organization?.name ?? '（未取到组织信息）'
  lines.push(`### ${env.key} — ${orgName}`)
  lines.push(`- 快照：${manifest.snapshotId}`)
  lines.push(`- 目录：${result.dir.replace(/\\/g, '/')}`)
  lines.push(`- 状态：${manifest.complete ? '完整' : '部分（见下方 issues）'}，耗时 ${(manifest.durationMs / 1000).toFixed(1)}s`)
  lines.push('')
  lines.push('| 资源 | 行数 | 请求 | 状态 |')
  lines.push('| --- | --- | --- | --- |')
  for (const [resource, detail] of Object.entries(manifest.resources)) {
    const status = detail.error
      ? `失败：${String(detail.error).slice(0, 60)}`
      : detail.truncated ? '被截断' : '完整'
    lines.push(`| ${resource} | ${detail.count ?? 0} | ${detail.requests ?? '-'} | ${status} |`)
  }
  if (manifest.issues.length) {
    lines.push('')
    lines.push('问题：')
    for (const issue of manifest.issues.slice(0, 12)) lines.push(`- ${issue.resource}：${issue.message}`)
    if (manifest.issues.length > 12) lines.push(`- … 另有 ${manifest.issues.length - 12} 条见 manifest.json`)
  }
  if (result.pruned.length) {
    lines.push('', `已清理旧快照：${result.pruned.join(', ')}（保留 ${config.snapshotKeep} 份）`)
  }
  if (!manifest.resources.attributes) {
    lines.push('', '未采集字段定义（attributes）。需要时加 includeAttributes: true，或指定 entities 只拉部分实体。')
  }
  return lines
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args = {}, exec) {
      const config = await loadConfig(state.rawConfig)
      const environments = pickEnvironments(config, args)
      const lines = [`同步快照：${environments.map((env) => env.key).join(' / ')}`]
      const failures = []

      for (const env of environments) {
        try {
          const result = await syncEnvironment(env, config, args, exec)
          lines.push('', ...renderSummary(result, config))
        } catch (error) {
          failures.push(`${env.key}：${error.message}`)
        }
      }

      if (failures.length) {
        lines.push('')
        lines.push('失败的环境：')
        for (const failure of failures) lines.push(`- ${failure}`)
      }

      return { text: lines.join('\n') }
    },
    presentCall(args = {}) {
      const envs = args.allEnvironments ? '全部环境' : (args.environments ?? []).join('/') || '默认环境'
      return {
        card: 'generic',
        title: `同步 D365 快照（${envs}）`,
        kind: 'other',
        rawInput: args,
      }
    },
  })
}
