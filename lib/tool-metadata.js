/**
 * `d365_metadata` — the generic, read-only metadata query.
 *
 * One tool over a fixed catalogue beats one tool per table: the catalogue is
 * small enough for a model to read, the arguments are the same shape for every
 * resource, and adding a table later is a data change, not a new tool.
 *
 * When several environments are named in one call, the result includes a
 * cross-environment comparison, because "does sit have it" is the common
 * question and running two calls by hand loses the alignment.
 */
import { loadConfig } from './config.js'
import {
  INLINE_ROWS,
  compareEnvironments,
  formatTable,
  hasWideCell,
  makeClient,
  mapEnvironments,
  pickEnvironments,
  writeArtifact,
} from './runtime.js'
import { RESOURCES, RESOURCE_KEYS, composeFilter, flattenLabels, odataString } from './resources.js'
import { getPagedWithSelectFallback } from './client.js'
import { D365Error } from './errors.js'
import { t } from './i18n.js'

/** Columns shown in the inline digest, per resource. Missing ones are skipped. */
const DISPLAY_FIELDS = {
  organization: ['name', 'version', 'organizationstructure', 'url'],
  entities: ['LogicalName', 'EntitySetName', 'IsCustomEntity', 'ObjectTypeCode'],
  attributes: ['LogicalName', 'AttributeType', 'IsCustomAttribute', 'RequiredLevel'],
  keys: ['SchemaName', 'LogicalName'],
  one_to_many_relationships: ['SchemaName', 'ReferencingEntity', 'ReferencedEntity'],
  many_to_many_relationships: ['SchemaName', 'Entity1LogicalName', 'Entity2LogicalName'],
  forms: ['name', 'type', 'objecttypecode', 'ismanaged', 'modifiedon'],
  views: ['name', 'querytype', 'isdefault', 'returnedtypecode'],
  workflows: ['name', 'type', 'category', 'statecode', 'primaryentity', 'modifiedon'],
  business_rules: ['name', 'type', 'statecode', 'primaryentity', 'modifiedon'],
  plugin_assemblies: ['name', 'version', 'isolationmode', 'sourcetype'],
  plugin_types: ['typename', 'friendlyname'],
  plugin_steps: ['message', 'plugintype', 'stage', 'mode', 'rank', 'filteringattributes'],
  step_images: ['name', 'imagetype', 'entityalias', 'attributes', 'ismanaged'],
  web_resources: ['name', 'webresourcetype', 'ismanaged', 'modifiedon'],
  solutions: ['uniquename', 'version', 'ismanaged', 'installedon'],
  solution_components: ['componenttype', 'objectid', 'solutionid'],
  custom_apis: ['uniquename', 'boundentitylogicalname', 'isfunction'],
  sitemaps: ['sitemapname', 'componentstate'],
  option_sets: ['Name', 'OptionSetType', 'IsCustomOptionSet'],
}

export const definition = {
  name: 'd365_metadata',
  description:
    'Read-only inspection of Dataverse metadata, including tables, columns, forms, views, workflows, plug-ins, web resources, and solutions. '
    + 'Multiple environments can be queried together and aligned by name. Returns a summary and an artifact path for full results. '
    + 'Use d365_metadata_write for definitions, d365_snapshot and d365_diff for environment drift, d365_layers for overrides, and d365_refs for references.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['resource'],
    properties: {
      resource: {
        type: 'string',
        enum: RESOURCE_KEYS,
        description: 'Metadata resource to query. Invalid values return the full supported list.',
      },
      entity: {
        type: 'string',
        description: 'Table logical name such as account or new_order; required by entity-scoped resources.',
      },
      name: {
        type: 'string',
        description: 'Exact name lookup, supported by option_sets; avoids loading all definitions.',
      },
      attribute: {
        type: 'string',
        description: 'For attributes: fetch one column; use cast for columns exposed only by a derived metadata type.',
      },
      cast: {
        type: 'string',
        description: 'For attributes: cast to a derived type such as BooleanAttributeMetadata; only valid with attribute.',
      },
      expand: {
        type: 'string',
        description: 'Additional $expand, such as "plugintypeid($select=typename)"; plugin_steps expands type and message by default.',
      },
      filter: {
        type: 'string',
        description: "OData $filter without the '$filter=' prefix, such as contains(name,'Approval').",
      },
      select: {
        type: 'string',
        description: 'Additional columns, comma-separated, such as "formxml,description"; unsupported columns are retried safely.',
      },
      orderby: {
        type: 'string',
        description: 'Override the default order, for example "modifiedon desc".',
      },
      top: {
        type: 'integer',
        description: 'Maximum rows. List-heavy resources default to 1000; others use configured maxRecords.',
      },
      environments: {
        type: 'array',
        items: { type: 'string' },
        description: 'Environment keys such as ["dev","sit"]; defaults to the configured default environment.',
      },
      allEnvironments: {
        type: 'boolean',
        description: 'Run the same query in every configured environment and compare.',
      },
      save: {
        type: 'boolean',
        description: 'Force the full result to an artifact file; by default, results over 12 rows are saved.',
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

/**
 * Choose the column list for the inline table.
 * @param resource - resource key.
 * @param rows - already-flattened rows.
 */
function displayColumns(resource, rows, selectArg) {
  const requested = String(selectArg ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  // An explicit `select` is the caller saying which columns matter; showing the
  // catalogue default instead is how "I asked for DefaultValue" ends up
  // rendered as four columns that do not include it.
  if (requested.length) {
    const present = requested.filter((field) => rows.some((row) => row?.[field] !== undefined))
    if (present.length) return present.slice(0, 8)
  }
  const preferred = DISPLAY_FIELDS[resource] ?? []
  const present = preferred.filter((field) => rows.some((row) => row?.[field] !== undefined))
  if (present.length >= 2) return present.slice(0, 6)
  const first = rows[0] ?? {}
  return Object.keys(first).filter((key) => !key.startsWith('@') && !key.endsWith('@odata.etag')).slice(0, 6)
}

/**
 * Build the request parameters for one resource.
 * @returns `{ path, params }`.
 */
function buildRequest(resource, args, config) {
  const def = RESOURCES[resource]
  if (!def) {
    throw new D365Error(t('metadata.unknownResource', { resource }), {
      code: 'unknown-resource',
      hint: t('metadata.available', { values: RESOURCE_KEYS.join(', ') }),
    })
  }
  if (def.entityScoped && !args.entity) {
    throw new D365Error(t('metadata.entityRequired', { resource }), {
      code: 'missing-entity',
      hint: t('metadata.entityRequiredHint', { resource }),
    })
  }

  // A filter on an endpoint that refuses `$filter` fails at the server with a
  // bare 405 that says nothing about what to do instead.
  if (def.filterable === false && args.filter) {
    throw new D365Error(t('metadata.filterUnsupported', { resource: def.summary ?? resource }), {
      code: 'filter-unsupported',
      hint: t('metadata.filterUnsupportedHint'),
    })
  }

  if (args.entity && !def.entityFilter) {
    throw new D365Error(t('metadata.entityUnsupported', { resource: def.summary ?? resource }), {
      code: 'entity-unsupported',
      hint: t('metadata.entityUnsupportedHint', { resource }),
    })
  }

  const keyedByName = def.keyedByName && args.name ? def.keyedByName(args.name) : null
  if (args.name && !keyedByName) {
    throw new D365Error(t('metadata.nameUnsupported', { resource: def.summary ?? resource }), {
      code: 'name-unsupported',
      hint: t('metadata.nameUnsupportedHint'),
    })
  }

  if (args.cast && !args.attribute) {
    throw new D365Error(t('metadata.castNeedsAttribute'), {
      code: 'cast-without-attribute',
      hint: t('metadata.castNeedsAttributeHint'),
    })
  }
  if (args.cast && !/^[A-Za-z]+AttributeMetadata$/.test(args.cast)) {
    throw new D365Error(t('metadata.badCast', { cast: args.cast }), {
      code: 'bad-cast',
      hint: t('metadata.badCastHint'),
    })
  }
  const keyedByAttribute = def.keyedByAttribute && args.attribute ? def.keyedByAttribute(args) : null
  if (args.attribute && !keyedByAttribute) {
    throw new D365Error(t('metadata.attributeUnsupported', { resource: def.summary ?? resource }), {
      code: 'attribute-unsupported',
      hint: t('metadata.attributeUnsupportedHint'),
    })
  }

  const keyed = keyedByName ?? keyedByAttribute

  const path = keyed ?? def.path(args)
  // The definition endpoints reject `$top` with 0x80060888 "The query
  // parameter ... is not supported", and `getPaged` adds `$top` unless told not
  // to — so without this every such query pays one wasted 400 before the
  // fallback notices. Declaring it up front removes a whole round trip.
  const rejectsTop = /^(entitydefinitions|relationshipdefinitions|globaloptionsetdefinitions)\b/i.test(path)

  const select = [def.select, args.select]
    .filter(Boolean)
    .join(',')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  const top = Number.isFinite(args.top)
    ? Math.max(1, Math.min(5000, Math.trunc(args.top)))
    : def.defaultTop ?? config.maxRecords

  return {
    path,
    keyed: Boolean(keyed),
    top,
    params: {
      $select: select.length ? [...new Set(select)].join(',') : undefined,
      // A keyed read answers with one object and rejects the collection-only
      // parameters that would otherwise be sent.
      $filter: keyed ? undefined : composeFilter(def, args),
      $orderby: keyed ? undefined : (args.orderby ?? def.orderby),
      $expand: keyed ? undefined : (args.expand ?? def.expand),
      __noTop: !keyed && rejectsTop ? true : undefined,
    },
  }
}

/**
 * Count the rows a request would return, without pulling them.
 *
 * A digest that says "200 rows" next to a truncated 5000-row table reads as
 * "there are 200"; the number that matters is how many were *not* shown.
 * @returns the total, or undefined when the endpoint refuses `$count`.
 */
async function countMatching(client, request, signal) {
  try {
    const url = client.buildUrl(request.path, {
      $filter: request.params.$filter,
      $count: 'true',
      $top: 1,
    })
    const page = await client.requestJson(url, { signal })
    const total = page?.['@odata.count']
    return typeof total === 'number' ? total : undefined
  } catch (error) {
    // A permission refusal is not "this set refuses $count" — surface it.
    if (error?.code === 'data-read-forbidden') throw error
    return undefined
  }
}

/** Lift the `$expand`ed lookups into flat, displayable columns. */
function flattenExpanded(row) {
  if (!row || typeof row !== 'object') return row
  const expanded = {}
  if (row.plugintypeid && typeof row.plugintypeid === 'object') expanded.plugintype = row.plugintypeid.typename
  if (row.sdkmessageid && typeof row.sdkmessageid === 'object') expanded.message = row.sdkmessageid.name
  return Object.keys(expanded).length ? { ...row, ...expanded } : row
}

/** The property name from "Could not find a property named 'x' on type 'y'". */
function missingProperty(message) {
  const match = /property named '([^']+)'/.exec(String(message ?? ''))
  return match ? match[1] : undefined
}

/** Query one environment and return rows plus provenance. */
async function queryEnvironment(env, config, args, signal) {
  const request = buildRequest(args.resource, args, config)
  const client = makeClient(env, config)
  const started = Date.now()
  let selectDropped = false
  let droppedFields = []
  let page
  if (request.keyed) {
    // Keyed metadata reads answer with a bare object (no `value` wrapper) and
    // 404 when the record is simply absent here, which is a normal answer.
    let params = request.params
    for (let attempt = 0; ; attempt += 1) {
      try {
        const row = await client.requestJson(client.buildUrl(request.path, params), { signal })
        page = { records: row ? [row] : [], hasMore: false }
        break
      } catch (error) {
        if (error?.status === 404) {
          page = { records: [], hasMore: false }
          break
        }
        const missing = error?.status === 400 && missingProperty(error.message)
        if (!missing || attempt >= 4) throw error
        const kept = String(params.$select ?? '').split(',').filter((column) => column.trim() && column.trim() !== missing)
        params = { ...params, $select: kept.length ? kept.join(',') : undefined }
        selectDropped = true
      }
    }
  } else {
    const paged = await getPagedWithSelectFallback(client, request.path, request.params, request.top, signal)
    page = paged.page
    selectDropped = paged.selectDropped
    droppedFields = paged.droppedFields ?? []
  }
  const rows = page.records.map((row) => flattenExpanded(flattenLabels(row)))
  // The organization table has no portable `version` column; take it from the
  // supported RetrieveVersion action so the resource still reports it.
  if (args.resource === 'organization' && rows.length) {
    const version = await client.readVersion(signal)
    if (version) rows[0] = { ...rows[0], version }
  }
  const total = page.hasMore ? await countMatching(client, request, signal) : rows.length
  return {
    env,
    rows,
    total,
    hasMore: page.hasMore,
    limit: request.top,
    selectDropped,
    droppedFields,
    requests: client.counters.requests,
    elapsedMs: Date.now() - started,
    filter: request.params.$filter,
  }
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args = {}, exec) {
      const config = await loadConfig(state.rawConfig)
      const environments = pickEnvironments(config, args)
      const resource = args.resource
      const def = RESOURCES[resource]

      const results = await mapEnvironments(environments, async (env) => {
        const envStarted = Date.now()
        try {
          return await queryEnvironment(env, config, args, exec?.signal)
        } catch (error) {
          // One environment failing must not hide the others.
          return { env, error, rows: [], elapsedMs: Date.now() - envStarted }
        }
      })
      const good = results.filter((result) => !result.error)

      const lines = []
      lines.push(t('metadata.queryHeading', { resource: def?.summary ?? resource, environments: environments.map((env) => env.key).join(' / ') }))
      if (args.entity) lines.push(t('metadata.entity', { value: args.entity }))
      if (args.name) lines.push(t('metadata.name', { value: args.name }))
      const filterText = results.find((item) => item.filter)?.filter
      if (filterText) lines.push(t('metadata.filter', { value: filterText }))
      if (def?.defaultFilter && !args.filter) {
        lines.push(t('metadata.definitionFilterNote', { filter: def.defaultFilter }))
      }

      for (const result of results) {
        lines.push('')
        if (result.error) {
          lines.push(`### ${result.env.key} — ${t('metadata.queryFailed')}`)
          lines.push(`- ${result.error.message ?? String(result.error)}`)
          if (result.error.hint) lines.push(`- ${t('metadata.hint', { value: result.error.hint })}`)
          continue
        }
        const totalText = result.hasMore && typeof result.total === 'number'
          ? t('metadata.totalKnown', { rows: result.rows.length, total: result.total >= 5000 ? '≥5000' : result.total })
          : result.hasMore
            ? t('metadata.totalUnknown', { rows: result.rows.length })
            : t('metadata.rows', { rows: result.rows.length })
        const seconds = Math.max(0, result.elapsedMs ?? 0) / 1000
        lines.push(`### ${result.env.key} — ${totalText} ${t('metadata.cost', { requests: result.requests ?? 0, seconds: seconds.toFixed(1) })}`)
        if (!result.rows.length) {
          lines.push(args.name
            ? t('metadata.noNamedRecord', { resource: def?.summary ?? resource, name: args.name })
            : t('metadata.noRows'))
          continue
        }
        const columns = displayColumns(resource, result.rows, args.select)
        lines.push(formatTable(result.rows, columns, { limit: INLINE_ROWS }))
        if (result.droppedFields?.length) {
          lines.push(t('metadata.columnsDropped', { fields: result.droppedFields.join(', ') }))
        } else if (result.selectDropped) {
          lines.push(t('metadata.selectDropped'))
        }
      }

      const comparison = compareEnvironments(resource, good.map((result) => ({ env: result.env, rows: result.rows })))
      if (comparison) {
        lines.push('')
        lines.push(`### ${t('metadata.comparison')}`)
        lines.push(...comparison.lines)
      }

      const totalRows = good.reduce((sum, result) => sum + result.rows.length, 0)
      const wide = good.some((result) => hasWideCell(result.rows, displayColumns(resource, result.rows, args.select)))
      const shouldSave = args.save === true || totalRows > INLINE_ROWS || wide
      if (shouldSave) {
        const path = await writeArtifact(config, `${resource}-${environments.map((env) => env.key).join('-')}`, {
          resource,
          args,
          generatedAt: new Date().toISOString(),
          environments: results.map((result) => ({
            env: result.env.key,
            url: result.env.url,
            count: result.rows.length,
            total: result.total,
            hasMore: result.hasMore,
            requests: result.requests,
            elapsedMs: result.elapsedMs,
            filter: result.filter,
            error: result.error ? String(result.error.message ?? result.error) : undefined,
            rows: result.rows,
          })),
          comparison: comparison ? { changed: comparison.changed, onlyIn: [...comparison.onlyIn.values()] } : undefined,
        })
        lines.push('')
        if (wide && totalRows <= INLINE_ROWS) {
          lines.push(t('metadata.wideValue'))
        }
        lines.push(t('metadata.fullResults', { path }))
      }

      return { text: lines.join('\n') }
    },
    presentCall(args = {}) {
      const envs = args.allEnvironments
        ? 'all environments'
        : [...(args.environments ?? []), args.environment].filter(Boolean).join('/') || 'default environment'
      return {
        card: 'generic',
        title: `Query ${args.resource}${args.entity ? `: ${args.entity}` : ''} (${envs})`,
        kind: 'other',
        rawInput: args,
      }
    },
  })
}
