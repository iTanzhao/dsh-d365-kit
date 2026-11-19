/**
 * `d365_snapshot` — pull a fixed metadata set into a local snapshot.
 *
 * Snapshots exist so that "what changed" is answerable without keeping the
 * live environment as the only source of truth. Each sync is a full pull (the
 * Dataverse metadata API has no delta for most tables); the value is not fewer
 * requests but a durable, comparable record with an honest completeness report.
 */
import { loadConfig } from './config.js'
import { makeClient, mapEnvironments, pickEnvironments, readOrganization } from './runtime.js'
import { RESOURCES, composeFilter, flattenLabels, odataString } from './resources.js'
import { getPagedWithSelectFallback } from './client.js'
import { D365Error } from './errors.js'
import { ensureDataRoot, pruneSnapshots, snapshotId, writeSnapshot } from './snapshot.js'
import { enforceRetention } from './retention.js'
import { t } from './i18n.js'

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
  name: 'd365_snapshot',
  description:
    'Pull D365 CE metadata from one or more environments into local snapshots under .d365/snapshots/<env>/<snapshotId>/, '
    + 'recording whether each resource is complete, truncated, or failed. Metadata is fetched through the live Web API and pulled in full because most metadata tables have no incremental cursor. '
    + 'Snapshots are for d365_diff and d365_contract; use d365_data_sync to migrate business records.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      environments: {
        type: 'array',
        items: { type: 'string' },
        description: 'Environment keys such as ["dev","sit"]; defaults to the configured environment.',
      },
      allEnvironments: {
        type: 'boolean',
        description: 'Synchronize every configured environment.',
      },
      resources: {
        type: 'array',
        items: { type: 'string', enum: Object.keys(RESOURCES) },
        description: 'Only the specified resources; defaults to core resources excluding attributes.',
      },
      includeAttributes: {
        type: 'boolean',
        description: 'Also fetch each table column definition; adds approximately one request per table and takes longer.',
      },
      entities: {
        type: 'array',
        items: { type: 'string' },
        description: 'With includeAttributes: only fetch columns for these tables, such as ["account","new_order"].',
      },
      maxRecords: {
        type: 'integer',
        description: 'Maximum rows per resource. Zero means all pages; positive limits are marked as truncated in the manifest.',
      },
      keep: {
        type: 'integer',
        description: 'Snapshots retained per environment; the oldest are deleted. Defaults to snapshotKeep (2).',
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
    // Definition collections reject `$top` outright (0x80060888). Keyed paths
    // such as `EntityDefinitions(LogicalName='x')/Attributes` accept it, so the
    // opt-out is limited to the collection roots.
    ...(/^(entitydefinitions|relationshipdefinitions|globaloptionsetdefinitions)$/i.test(path) ? { __noTop: true } : {}),
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
  // An entity with more attributes than the row cap contributes only half a
  // table; without recording it, a later diff reports the missing half as
  // removed attributes.
  const truncatedEntities = []
  const started = Date.now()

  await mapLimit(entityNames, 4, async (entity) => {
    try {
      const page = await fetchResource(client, 'attributes', { entity, top, signal })
      for (const row of page.records) rows.push({ entity, ...flattenLabels(row) })
      if (page.hasMore) truncatedEntities.push(entity)
    } catch (error) {
      failures.push({ entity, message: error.message })
    }
  })

  return { rows, failures, truncatedEntities, elapsedMs: Date.now() - started }
}

/**
 * Fetch one entity-scoped resource once per entity.
 *
 * The path is `EntityDefinitions(LogicalName='...')/Keys`: without a concrete
 * name the request would ask for the entity `undefined`, so an empty entity
 * list is never passed here. Failures are returned per entity, like the
 * attribute walk, so one bad name does not hide the rest.
 */
async function fetchEntityScoped(client, resource, entityNames, top, signal) {
  const parts = await mapLimit(entityNames, 4, async (entity) => {
    try {
      const page = await fetchResource(client, resource, { entity, top, signal })
      return {
        entity,
        rows: page.records.map((row) => ({ entity, ...flattenLabels(row) })),
        truncated: page.hasMore,
      }
    } catch (error) {
      return { entity, rows: [], truncated: false, message: error.message }
    }
  })
  const failures = parts.filter((part) => part.message).map(({ entity, message }) => ({ entity, message }))
  return {
    rows: parts.flatMap((part) => part.rows),
    // A per-entity failure is missing data too, not just a row-cap overflow.
    truncated: parts.some((part) => part.truncated) || failures.length > 0,
    failures,
  }
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
    throw new D365Error(`Unknown resources: ${unknown.join(', ')}`, { code: 'unknown-resource', i18nParams: { values: unknown.join(', ') }, i18nKey: 'snapshot.unknownResources', hintKey: 'snapshot.availableResources', hintParams: { values: Object.keys(RESOURCES).join(', ') } })
  }

  // Unlimited by default: a snapshot with rows silently missing is worse than a
  // slow sync, and `d365_diff` would report the missing rows as deletions.
  const maxRecords = args.maxRecords === undefined || args.maxRecords === 0
    ? Number.POSITIVE_INFINITY
    : Number.isFinite(args.maxRecords) && args.maxRecords > 0
      ? Math.min(1_000_000, Math.trunc(args.maxRecords))
      : Math.max(20_000, config.maxRecords)

  const organizationStarted = Date.now()
  const organizationRequestsBefore = client.counters.requests
  const organizationRow = flattenLabels(await readOrganization(client, exec?.signal))
  const organizationStats = {
    requests: client.counters.requests - organizationRequestsBefore,
    elapsedMs: Date.now() - organizationStarted,
  }

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
    details.organization = { count: 1, truncated: false, ...organizationStats }
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
        issues.push({ resource: 'entities', message: t('snapshot.entityLimit', { max: maxRecords }) })
      }
    } catch (error) {
      entitiesTruncated = true
      issues.push({ resource: 'entities', message: error.message })
      details.entities = { count: 0, truncated: true, requests: client.counters.requests - before, elapsedMs: Date.now() - started, error: error.message }
    }
  }

  // Entity-scoped resources (attributes, keys, relationships) build their path
  // from one entity name: without one the URL would read
  // EntityDefinitions(LogicalName='undefined')/Keys. Walk the explicit
  // `entities` argument, or the entity list this run already fetched, and skip
  // with a note when neither exists.
  const entityScoped = requested.filter((resource) => RESOURCES[resource]?.entityScoped === true)
  const derivedEntities = !explicitEntities.length
  const entityTargets = explicitEntities.length
    ? explicitEntities
    : (entitiesRows ?? []).map((row) => row.LogicalName).filter((name) => typeof name === 'string' && name.trim())
  const entitySkipped = new Set()
  for (const resource of entityScoped) {
    if (entityTargets.length) continue
    entitySkipped.add(resource)
    issues.push({
      resource,
      message: t('snapshot.entityRequired'),
    })
  }

  for (const resource of requested) {
    if (resource === 'entities') continue
    if (entitySkipped.has(resource)) continue
    // `includeAttributes` walks attributes per entity with its own failure and
    // truncation bookkeeping; pulling them here as well would double the requests.
    if (resource === 'attributes' && wantAttributes) continue
    const started = Date.now()
    const before = client.counters.requests
    try {
      const scoped = RESOURCES[resource]?.entityScoped === true
      const fetched = scoped
        ? await fetchEntityScoped(client, resource, entityTargets, maxRecords, exec?.signal)
        : await fetchResource(client, resource, { top: maxRecords, signal: exec?.signal })
          .then((page) => ({ rows: page.records.map((row) => flattenLabels(row)), truncated: page.hasMore, failures: [] }))
      const rows = fetched.rows
      // When the targets came from a truncated entity list, the per-entity pull
      // is partial for the same reason.
      const truncated = fetched.truncated || (scoped && derivedEntities && entitiesTruncated)
      const payload = {
        resource,
        env: env.key,
        snapshotId: id,
        generatedAt: new Date().toISOString(),
        count: rows.length,
        truncated,
        rows,
      }
      if (scoped) {
        payload.entities = entityTargets.length
        payload.failures = fetched.failures
      }
      files.push({ resource, payload })
      details[resource] = {
        count: rows.length,
        truncated,
        requests: client.counters.requests - before,
        elapsedMs: Date.now() - started,
      }
      if (scoped) details[resource].entities = entityTargets.length
      if (fetched.failures.length) details[resource].failedEntities = fetched.failures.length
      if (fetched.truncated) {
        issues.push({
          resource,
          message: scoped ? t('snapshot.scopedIncomplete') : t('snapshot.resourceLimit', { max: maxRecords }),
        })
      } else if (truncated) {
        issues.push({ resource, message: t('snapshot.entityListTruncated') })
      }
      for (const failure of fetched.failures.slice(0, 10)) {
        issues.push({ resource: `${resource}:${failure.entity}`, message: failure.message })
      }
      if (fetched.failures.length > 10) {
        issues.push({ resource, message: t('snapshot.moreEntityFailures', { count: fetched.failures.length - 10 }) })
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
      issues.push({ resource: 'attributes', message: t('snapshot.entityCap', { cap: MAX_ATTRIBUTE_ENTITIES }) })
    }

    const started = Date.now()
    const result = await fetchAttributes(client, capped, maxRecords, exec?.signal)
    const truncated = entitiesTruncated || !capped.length || names.length > capped.length
      || result.failures.length > 0 || result.truncatedEntities.length > 0
    if (!capped.length) {
      issues.push({ resource: 'attributes', message: t('snapshot.noEntities') })
    }
    files.push({
      resource: 'attributes',
      payload: {
        resource: 'attributes',
        env: env.key,
        snapshotId: id,
        generatedAt: new Date().toISOString(),
        count: result.rows.length,
        truncated,
        entities: capped.length,
        failures: result.failures,
        truncatedEntities: result.truncatedEntities,
        rows: result.rows,
      },
    })
    details.attributes = {
      count: result.rows.length,
      truncated,
      entities: capped.length,
      failedEntities: result.failures.length,
      elapsedMs: result.elapsedMs,
    }
    if (result.truncatedEntities.length) {
      details.attributes.truncatedEntities = result.truncatedEntities.length
    }
    for (const failure of result.failures.slice(0, 10)) {
      issues.push({ resource: `attributes:${failure.entity}`, message: failure.message })
    }
    if (result.failures.length > 10) {
      issues.push({ resource: 'attributes', message: t('snapshot.moreAttributeFailures', { count: result.failures.length - 10 }) })
    }
    for (const entity of result.truncatedEntities.slice(0, 10)) {
      issues.push({ resource: `attributes:${entity}`, message: t('snapshot.attributeLimit', { max: maxRecords }) })
    }
    if (result.truncatedEntities.length > 10) {
      issues.push({ resource: 'attributes', message: t('snapshot.moreAttributeTruncated', { count: result.truncatedEntities.length - 10 }) })
    }
  }

  const finishedAt = new Date()
  // Only advertise resources whose file was actually written: a resource that
  // was skipped or failed has no JSON file, and a later diff would read the
  // manifest entry as "collected, file missing".
  const written = new Set(files.map((file) => file.resource))
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
    resources: Object.fromEntries(
      Object.entries(details).filter(([resource]) => written.has(resource)),
    ),
    requested: ['organization', ...requested, ...(wantAttributes ? ['attributes'] : [])],
  }

  await ensureDataRoot(config)
  const dir = await writeSnapshot(config, env.key, id, manifest, files)
  const explicitKeep = Number.isFinite(args.keep) && args.keep > 0 ? Math.trunc(args.keep) : null
  const keep = explicitKeep ?? config.snapshotKeep
  const pruned = await pruneSnapshots(config, env.key, keep)
  // The retention plan takes `keep` from config.snapshotKeep, so running it
  // after an explicit `keep: 10` would immediately prune back down to 2.
  if (explicitKeep === null) await enforceRetention(config, { target: 'snapshots' })

  return { env, id, dir, manifest, pruned, keep, organization: organizationRow }
}

/** Render one environment's sync summary. */
function renderSummary(result, config) {
  const { env, manifest } = result
  const lines = []
  const orgName = manifest.organization?.name ?? t('snapshot.orgUnavailable')
  lines.push(`### ${env.key} — ${orgName}`)
  lines.push(`- ${t('snapshot.snapshot')}: ${manifest.snapshotId}`)
  lines.push(`- ${t('snapshot.directory')}: ${result.dir.replace(/\\/g, '/')}`)
  lines.push(t('snapshot.statusLine', { status: manifest.complete ? t('snapshot.complete') : t('snapshot.partial'), duration: (manifest.durationMs / 1000).toFixed(1) }))
  lines.push('')
  lines.push(t('snapshot.tableHead'))
  lines.push('| --- | --- | --- | --- |')
  for (const [resource, detail] of Object.entries(manifest.resources)) {
    const status = detail.error
      ? t('snapshot.failedStatus', { error: String(detail.error).slice(0, 60) })
      : detail.truncated ? t('snapshot.truncated') : t('snapshot.complete')
    lines.push(`| ${resource} | ${detail.count ?? 0} | ${detail.requests ?? '-'} | ${status} |`)
  }
  if (manifest.issues.length) {
    lines.push('')
    lines.push(t('snapshot.issues'))
    for (const issue of manifest.issues.slice(0, 12)) lines.push(`- ${issue.resource}：${issue.message}`)
    if (manifest.issues.length > 12) lines.push(t('snapshot.moreIssues', { count: manifest.issues.length - 12 }))
  }
  if (result.pruned.length) {
    lines.push('', t('snapshot.pruned', { values: result.pruned.join(', '), keep: result.keep ?? config.snapshotKeep }))
  }
  if (!manifest.resources.attributes) {
    lines.push('', t('snapshot.noAttributes'))
  }
  return lines
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args = {}, exec) {
      const config = await loadConfig(state.rawConfig)
      const environments = pickEnvironments(config, args)
      const lines = [t('snapshot.heading', { environments: environments.map((env) => env.key).join(' / ') })]
      const failures = []

      const results = await mapEnvironments(environments, async (env) => {
        try {
          return await syncEnvironment(env, config, args, exec)
        } catch (error) {
          return { env, error }
        }
      })
      for (const result of results) {
        if (result.error) failures.push(`${result.env.key}: ${result.error.message}`)
        else lines.push('', ...renderSummary(result, config))
      }

      if (failures.length) {
        lines.push('')
        lines.push(t('snapshot.failedEnvironments'))
        for (const failure of failures) lines.push(`- ${failure}`)
      }

      return { text: lines.join('\n') }
    },
    presentCall(args = {}) {
      const envs = args.allEnvironments ? t('snapshot.allEnvironments') : (args.environments ?? []).join('/') || t('snapshot.defaultEnvironment')
      return {
        card: 'generic',
        title: t('snapshot.title', { environments: envs }),
        kind: 'other',
        rawInput: args,
      }
    },
  })
}
