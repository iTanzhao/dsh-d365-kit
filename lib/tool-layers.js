/**
 * `d365_layers` — solution layers of metadata components.
 *
 * The layer table (`msdyn_componentlayers`) is the only place that reveals the
 * *stack* behind a component: which solution last touched it, in what order,
 * and which definition is currently winning. For a team that ships solution
 * zips by hand across four environments, that stack is usually the real answer
 * to "why does this form look different in UAT".
 */
import { loadConfig } from './config.js'
import {
  INLINE_ROWS,
  formatTable,
  makeClient,
  mapEnvironments,
  pickEnvironments,
  writeArtifact,
} from './runtime.js'
import { getPagedWithSelectFallback } from './client.js'
import { odataString } from './resources.js'
import { D365Error } from './errors.js'
import { t } from './i18n.js'

/** Base columns; `msdyn_componentjson` is only added on request (it can be huge). */
const BASE_SELECT = [
  'msdyn_componentlayerid',
  'msdyn_name',
  'msdyn_solutioncomponentname',
  'msdyn_solutionname',
  'msdyn_publishername',
  'msdyn_order',
  'msdyn_componentid',
  'msdyn_overwritetime',
]

export const definition = {
  name: 'd365_layers',
  description: "Inspect Dataverse solution layers (msdyn_componentlayers): which solutions overlap a component, layer order, and the active layer. Use this to explain why forms, fields, or views differ across environments; use d365_migrate for import impact and d365_refs for references.",
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      component: {
        type: 'string',
        description: 'Component name or GUID. Use a logical name for Entity (account); use the record name/unique name for other component types.',
      },
      componentType: {
        type: 'string',
        enum: [
          'Entity',
          'Attribute',
          'SystemForm',
          'SavedQuery',
          'Workflow',
          'WebResource',
          'PluginAssembly',
          'PluginType',
          'SdkMessageProcessingStep',
          'CustomAPI',
          'OptionSet',
        ],
        description: 'Component type. The layer table is virtual and requires both component id and type; otherwise it returns an empty set.',
      },
      entity: {
        type: 'string',
        description: 'Required for componentType=Attribute: logical name of the field entity.',
      },
      solution: {
        type: 'string',
        description: 'Only layers from this solution (unique name). Filtering happens server-side, so layers beyond top cannot cause a false no-layer result.',
      },
      includeJson: {
        type: 'boolean',
        description: 'Also retrieve msdyn_componentjson (the full layer definition, up to 1 GB); it is written to the artifact rather than expanded inline.',
      },
      top: {
        type: 'integer',
        description: 'Maximum layer rows to return; default 500.',
      },
      environments: {
        type: 'array',
        items: { type: 'string' },
        description: 'Environment keys, for example ["dev","sit"]. Omit to use the default environment.',
      },
      allEnvironments: {
        type: 'boolean',
        description: 'Run the same query in every configured environment and compare results.',
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
 * How each solution-component type resolves a human name to the component id
 * the layer table needs, and the `msdyn_solutioncomponentname` value it stores.
 *
 * The layer table is a virtual entity: an unfiltered query, or a filter with
 * only one of (component id, component type), returns an empty set — the
 * portal's own request always sends both.
 */
export const COMPONENT_TYPES = {
  Entity: { stored: 'Entity', lookup: { path: (name) => `EntityDefinitions(LogicalName='${odataString(name)}')`, id: 'MetadataId' } },
  Attribute: {
    stored: 'Attribute',
    lookup: {
      path: (name, args) => `EntityDefinitions(LogicalName='${odataString(args.entity ?? '')}')/Attributes(LogicalName='${odataString(name)}')`,
      id: 'MetadataId',
      requiresEntity: true,
    },
  },
  SystemForm: { stored: 'SystemForm', lookup: { path: () => 'systemforms', field: 'name', id: 'formid' } },
  SavedQuery: { stored: 'SavedQuery', lookup: { path: () => 'savedqueries', field: 'name', id: 'savedqueryid' } },
  Workflow: { stored: 'Workflow', lookup: { path: () => 'workflows', field: 'name', id: 'workflowid' } },
  WebResource: { stored: 'WebResource', lookup: { path: () => 'webresourceset', field: 'name', id: 'webresourceid' } },
  PluginAssembly: { stored: 'PluginAssembly', lookup: { path: () => 'pluginassemblies', field: 'name', id: 'pluginassemblyid' } },
  PluginType: { stored: 'PluginType', lookup: { path: () => 'plugintypes', field: 'typename', id: 'plugintypeid' } },
  SdkMessageProcessingStep: {
    stored: 'SdkMessageProcessingStep',
    lookup: { path: () => 'sdkmessageprocessingsteps', field: 'name', id: 'sdkmessageprocessingstepid' },
  },
  CustomAPI: { stored: 'CustomAPI', lookup: { path: () => 'customapis', field: 'uniquename', id: 'customapiid' } },
  // Global option sets live on their own metadata endpoint and are keyed by
  // name, not by a record id. Local option sets are part of an attribute and
  // are reached through `Attribute` instead — `GlobalOptionSetDefinitions`
  // knows nothing about them.
  OptionSet: {
    stored: 'OptionSet',
    lookup: { path: (name) => `GlobalOptionSetDefinitions(Name='${odataString(name)}')`, id: 'MetadataId' },
  },
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Read at most one row, whether the path is keyed (`EntityDefinitions(...)`,
 * which answers with a bare object and rejects `$top`) or a collection.
 */
async function lookupOne(client, path, params, signal) {
  // A keyed read (`/EntityDefinitions(LogicalName='x')`) answers 404 when the
  // component is simply not in this org — that is a normal "absent here", not
  // a transport failure, and must not abort a multi-environment call.
  const absentAsUndefined = async (request) => {
    try {
      return await request()
    } catch (error) {
      if (error?.status === 404) return undefined
      throw error
    }
  }

  try {
    return await absentAsUndefined(() => client.getOne(path, params, signal))
  } catch (error) {
    if (error?.status !== 400) throw error
    // Keyed metadata paths reject `$top`, which `getOne` adds; retry without it.
    return absentAsUndefined(async () => {
      const payload = await client.requestJson(client.buildUrl(path, params), { signal })
      return Array.isArray(payload?.value) ? payload.value[0] : payload
    })
  }
}

/** Resolve the argument to a component GUID for one environment. */
export async function resolveComponentId(client, args, signal) {
  const type = args.componentType
  const spec = COMPONENT_TYPES[type]
  if (!spec) {
    throw new D365Error(t('layers.unsupportedType',{type:type??t('layers.unspecified')}), {
      code: 'bad-component-type',
      hint: t('layers.availableTypes',{types:Object.keys(COMPONENT_TYPES).join(', ')}),
    })
  }

  const raw = String(args.component ?? '').trim()
  if (!raw) {
    throw new D365Error(t('layers.missingComponent'), {
      code: 'missing-component',
      hint: type === 'Entity' ? t('layers.exampleEntity') : t('layers.componentHint'),
    })
  }
  if (GUID.test(raw)) return raw

  if (spec.lookup.requiresEntity && !args.entity) {
    throw new D365Error(t('layers.missingEntity'), {
      code: 'missing-entity',
      hint: t('layers.exampleAttribute'),
    })
  }

  const path = spec.lookup.path(raw, args)
  const params = spec.lookup.field
    ? { $select: spec.lookup.id, $filter: `${spec.lookup.field} eq '${odataString(raw)}'` }
    : { $select: spec.lookup.id }
  const row = await lookupOne(client, path, params, signal)
  const id = row?.[spec.lookup.id]
  if (!id) {
    throw new D365Error(t('layers.notFound',{type,name:raw}), {
      code: 'component-not-found',
      hint: type === 'OptionSet'
        ? t('layers.optionSetHint')
        : t('layers.nameHint'),
    })
  }
  return id
}

/** Compose the layer filter for one resolved component. */
export function buildComponentFilter(componentId, componentType) {
  const stored = COMPONENT_TYPES[componentType]?.stored ?? componentType
  return `(msdyn_componentid eq '${odataString(componentId)}' and msdyn_solutioncomponentname eq '${odataString(stored)}')`
}

/** Group layer rows by component. */
function groupLayers(rows) {
  const groups = new Map()
  for (const row of rows) {
    const type = row.msdyn_solutioncomponentname ?? '?'
    const name = row.msdyn_name ?? t('layers.unnamed')
    const key = `${type}::${name}`
    if (!groups.has(key)) groups.set(key, { type, name, layers: [] })
    groups.get(key).layers.push(row)
  }
  for (const group of groups.values()) {
    group.layers.sort((a, b) => Number(a.msdyn_order ?? 0) - Number(b.msdyn_order ?? 0))
    group.active = group.layers[group.layers.length - 1]
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type))
}

/** Short solution label; the system layer has no solution name. */
export const solutionLabel = (layer) => (layer?.msdyn_solutionname ? layer.msdyn_solutionname : t('layers.system'))

/**
 * Dataverse parks the unmanaged customization layer under the pseudo-solution
 * name "Active" — it is the only layer a developer can remove, and it always
 * sits on top of the managed stack when it exists.
 */
export const isActiveLayer = (layer) => /^active$/i.test(layer?.msdyn_solutionname ?? '')

/** Layer label that says out loud which layer is the unmanaged one. */
function layerLabel(layer) {
  if (isActiveLayer(layer)) return t('layers.activeUnmanaged')
  return solutionLabel(layer)
}

/** Timestamps the provider leaves at DateTime.MinValue carry no information. */
function formatTime(value) {
  if (!value) return '—'
  const text = String(value).replace('T', ' ').slice(0, 19)
  return /^(0001|0000|1899|1900)/.test(text) ? '—' : text
}

/**
 * The Active layer's `msdyn_overwritetime` is always DateTime.MinValue, so a
 * bare "—" would read like a formatting accident. Say what it means instead.
 */
function formatLayerTime(layer) {
  return isActiveLayer(layer) ? t('layers.notRecorded') : formatTime(layer?.msdyn_overwritetime)
}

/** One readable line for a per-environment failure. */
function describeFailure(error) {
  // The D365Error message already carries a hint, which reads badly
  // nested inside another sentence — say it plainly for this one case instead.
  if (error?.code === 'component-not-found') {
    return t('layers.environmentMissing')
  }
  return String(error?.message ?? error ?? t('layers.unknownError'))
}

/** Render one environment's layer stack. */
function renderEnvironment(result, includeJson) {
  const lines = []
  const groups = groupLayers(result.rows)
  lines.push(t('layers.env.heading', {
    env: result.env.key,
    rows: result.rows.length,
    groups: groups.length,
    truncated: result.hasMore ? t('layers.truncated') : '',
  }))
  if (!groups.length) {
    lines.push(t('layers.noLayers'))
    return { lines, groups }
  }

  const headers = [t('layers.col.component'), t('layers.col.type'), t('layers.col.count'), t('layers.col.active'), t('layers.col.order'), t('layers.col.updated')]
  const summaryRows = groups.map((group) => ({
    [headers[0]]: group.name,
    [headers[1]]: group.type,
    [headers[2]]: group.layers.length,
    [headers[3]]: layerLabel(group.active),
    [headers[4]]: group.active?.msdyn_order ?? '',
    [headers[5]]: formatLayerTime(group.active),
  }))
  lines.push('')
  lines.push(t('layers.activeHeading'))
  lines.push(formatTable(summaryRows, headers, { limit: INLINE_ROWS }))

  const unmanaged = groups.filter((group) => isActiveLayer(group.active))
  lines.push('')
  lines.push(unmanaged.length ? t('layers.unmanaged', { count: unmanaged.length }) : t('layers.noUnmanaged'))

  const stacked = groups.filter((group) => group.layers.filter((layer) => layer.msdyn_solutionname).length > 1)
  if (stacked.length) {
    lines.push('')
    lines.push(t('layers.stacked', { count: stacked.length }))
    for (const group of stacked.slice(0, 10)) {
      const chain = group.layers.map((layer) => `${layer.msdyn_order}:${layerLabel(layer)}`).join(' → ')
      lines.push(`- ${group.name} (${group.type}): ${chain}`)
    }
    if (stacked.length > 10) lines.push('- ' + t('layers.more', { count: stacked.length - 10 }))
  }

  if (includeJson) lines.push('', t('layers.jsonArtifact'))
  return { lines, groups }
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args = {}, exec) {
      const config = await loadConfig(state.rawConfig)
      const environments = pickEnvironments(config, args)
      const top = Number.isFinite(args.top) ? Math.max(1, Math.min(5000, Math.trunc(args.top))) : 500
      const select = [...BASE_SELECT, args.includeJson ? 'msdyn_componentjson' : null].filter(Boolean).join(',')

      const results = await mapEnvironments(environments, async (env) => {
        try {
          const client = makeClient(env, config)
          const componentId = await resolveComponentId(client, args, exec?.signal)
          const componentFilter = buildComponentFilter(componentId, args.componentType)
          // `solution` has to go into `$filter`, not after paging: a component
          // can have more layers than `top`, and filtering the returned page
          // would then report "this solution has no layer" for a layer that
          // exists but fell outside the page.
          const filter = args.solution
            ? `${componentFilter} and msdyn_solutionname eq '${odataString(args.solution)}'`
            : componentFilter
          // No `$orderby`: the virtual provider only guarantees the id+type
          // filter, and ordering is applied after the rows arrive.
          const { page, selectDropped } = await getPagedWithSelectFallback(
            client,
            'msdyn_componentlayers',
            { $select: select, $filter: filter },
            top,
            exec?.signal,
          )
          const rows = page.records
          return {
            env,
            ok: true,
            componentId,
            rows: rows.sort((a, b) => Number(a.msdyn_order ?? 0) - Number(b.msdyn_order ?? 0)),
            hasMore: page.hasMore,
            selectDropped,
            filter,
          }
        } catch (error) {
          // One environment missing the component must not sink the others:
          // this is the common "component exists in UAT but not in SIT" case.
          return { env, ok: false, error }
        }
      })
      if (results.length && results.every((result) => !result.ok)) throw results[0].error

      const lines = [t('layers.heading', { envs: environments.map((env) => env.key).join(' / ') })]
      lines.push(t('layers.component', {
        type: args.componentType ?? '?',
        name: args.component ?? '?',
        entity: args.entity ? ` (${args.entity})` : '',
      }))
      if (args.solution) lines.push(t('layers.solution', { solution: args.solution }))

      const perEnv = []
      for (const result of results) {
        lines.push('')
        if (!result.ok) {
          lines.push(`### ${result.env.key} — ${t('layers.queryFailed')}`)
          lines.push(`- ${describeFailure(result.error)}`)
          continue
        }
        const rendered = renderEnvironment(result, args.includeJson)
        lines.push(...rendered.lines)
        if (result.selectDropped) lines.push(t('layers.selectFallback'))
        perEnv.push({ env: result.env, groups: rendered.groups })
      }

      if (perEnv.length > 1) {
        lines.push('')
        lines.push(t('layers.compare'))
        const maps = perEnv.map((entry) => ({
          env: entry.env.key,
          map: new Map(entry.groups.map((group) => [`${group.type}::${group.name}`, group])),
        }))
        const allKeys = [...new Set(maps.flatMap((entry) => [...entry.map.keys()]))]
        const diffs = []
        for (const key of allKeys) {
          const name = key.split('::')[1]
          const present = maps.filter((entry) => entry.map.has(key))
          const absent = maps.filter((entry) => !entry.map.has(key))
          if (absent.length) {
            diffs.push(t('layers.presence', {
              name,
              present: present.map((entry) => entry.env).join('/'),
              absent: absent.map((entry) => entry.env).join('/'),
            }))
            continue
          }

          // Compare the whole stack, not just the winner: a solution present in
          // one environment shifts every layer above it, which is exactly the
          // drift this comparison is for.
          const stacks = maps.map((entry) => ({
            env: entry.env,
            layers: new Map(entry.map.get(key).layers.map((layer) => [layerLabel(layer), Number(layer.msdyn_order ?? 0)])),
          }))
          const allSolutions = [...new Set(stacks.flatMap((entry) => [...entry.layers.keys()]))]
          // Group the differing solutions by *which* environments carry them, so
          // four environments read as two statements instead of ten.
          const buckets = new Map()
          for (const solution of allSolutions) {
            const carriers = stacks.filter((entry) => entry.layers.has(solution)).map((entry) => entry.env)
            if (carriers.length === stacks.length) continue
            const bucketKey = carriers.join('/')
            if (!buckets.has(bucketKey)) buckets.set(bucketKey, { carriers, solutions: [] })
            buckets.get(bucketKey).solutions.push(solution)
          }
          if (buckets.size) {
            const detail = [...buckets.values()].map((bucket) => {
              const missing = stacks.filter((entry) => !bucket.carriers.includes(entry.env)).map((entry) => entry.env)
              return t('layers.bucket', {
                carriers: bucket.carriers.join('/'),
                count: bucket.solutions.length,
                missing: missing.join('/'),
                solutions: bucket.solutions.join(', '),
              })
            })
            diffs.push(t('layers.stackDiff', { name, detail: detail.join('\n') }))
          }

          const actives = maps.map((entry) => `${entry.env}=${layerLabel(entry.map.get(key).active)}`)
          if (new Set(maps.map((entry) => layerLabel(entry.map.get(key).active))).size > 1) {
            diffs.push(t('layers.activeDiff', { name, values: actives.join(' / ') }))
          }
        }
        if (!diffs.length) lines.push(t('layers.same'))
        else {
          for (const line of diffs.slice(0, 15)) lines.push(`- ${line}`)
          if (diffs.length > 15) lines.push(t('layers.moreDiffs', { count: diffs.length - 15 }))
        }
      }

      const path = await writeArtifact(config, `layers-${environments.map((env) => env.key).join('-')}`, {
        args,
        generatedAt: new Date().toISOString(),
        environments: results.map((result) => (result.ok
          ? {
            env: result.env.key,
            url: result.env.url,
            ok: true,
            componentId: result.componentId,
            filter: result.filter,
            hasMore: result.hasMore,
            rows: result.rows,
          }
          : {
            env: result.env.key,
            url: result.env.url,
            ok: false,
            error: String(result.error?.message ?? result.error ?? ''),
          })),
      })
      lines.push('', t('layers.artifact', { path }))
      lines.push(t('layers.footer'))

      return { text: lines.join('\n') }
    },
    presentCall(args = {}) {
      const envs = args.allEnvironments ? t('layers.allEnvs') : (args.environments ?? []).join('/') || t('layers.defaultEnv')
      return {
        card: 'generic',
        title: t('layers.card', { component: args.component ? `: ${args.component}` : '', envs }),
        kind: 'other',
        rawInput: args,
      }
    },
  })
}
