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
  pickEnvironments,
  writeArtifact,
} from './runtime.js'
import { getPagedWithSelectFallback } from './client.js'
import { odataString } from './resources.js'
import { D365Error } from './errors.js'

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
  description:
    '查询 D365 CE 元数据组件的解决方案层（msdyn_componentlayers）：每个组件被哪些解决方案覆盖过、层的先后顺序、当前生效的是哪一层。'
    + '用于判断"为什么这个环境里的表单/字段/视图和别的环境不一样"。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      component: {
        type: 'string',
        description: '组件名或组件 GUID。Entity 用逻辑名（account）；其它类型用该类记录的名称/唯一名。',
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
        ],
        description: '组件类型。层表是虚拟实体，必须同时给出组件 id 和类型，否则返回空集。',
      },
      entity: {
        type: 'string',
        description: 'componentType=Attribute 时必填：字段所属实体的逻辑名。',
      },
      solution: {
        type: 'string',
        description: '只看某个解决方案的层（解决方案唯一名），在返回结果里过滤。',
      },
      includeJson: {
        type: 'boolean',
        description: '同时取回 msdyn_componentjson（组件在该层的完整定义，最大 1GB，会写入文件而非直接展开）。',
      },
      top: {
        type: 'integer',
        description: '最多取多少条层记录，默认 500。',
      },
      environments: {
        type: 'array',
        items: { type: 'string' },
        description: '环境 key 列表，例如 ["dev","sit"]。省略则用默认环境。',
      },
      allEnvironments: {
        type: 'boolean',
        description: '对全部已配置环境执行同一查询并比较。',
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
    throw new D365Error(`不支持的组件类型：${type ?? '（未指定）'}`, {
      code: 'bad-component-type',
      hint: `可用：${Object.keys(COMPONENT_TYPES).join(', ')}`,
    })
  }

  const raw = String(args.component ?? '').trim()
  if (!raw) {
    throw new D365Error('缺少 component', {
      code: 'missing-component',
      hint: type === 'Entity' ? '例如 component: "account"' : '传组件名或 GUID。',
    })
  }
  if (GUID.test(raw)) return raw

  if (spec.lookup.requiresEntity && !args.entity) {
    throw new D365Error('查询字段（Attribute）的层需要 entity 参数', {
      code: 'missing-entity',
      hint: `例如 {"componentType":"Attribute","component":"name","entity":"account"}`,
    })
  }

  const path = spec.lookup.path(raw, args)
  const params = spec.lookup.field
    ? { $select: spec.lookup.id, $filter: `${spec.lookup.field} eq '${odataString(raw)}'` }
    : { $select: spec.lookup.id }
  const row = await lookupOne(client, path, params, signal)
  const id = row?.[spec.lookup.id]
  if (!id) {
    throw new D365Error(`找不到 ${type} "${raw}"`, {
      code: 'component-not-found',
      hint: '名字要精确匹配（Entity 用逻辑名，其它用记录名称/唯一名），也可以直接传组件 GUID。',
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
    const name = row.msdyn_name ?? '(未命名)'
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
export const solutionLabel = (layer) => (layer?.msdyn_solutionname ? layer.msdyn_solutionname : '（系统层）')

/** Timestamps the provider leaves at DateTime.MinValue carry no information. */
function formatTime(value) {
  if (!value) return '—'
  const text = String(value).replace('T', ' ').slice(0, 19)
  return /^(0001|0000|1899|1900)/.test(text) ? '—' : text
}

/** One readable line for a per-environment failure. */
function describeFailure(error) {
  // The D365Error message already carries a " 建议：" hint, which reads badly
  // nested inside another sentence — say it plainly for this one case instead.
  if (error?.code === 'component-not-found') {
    return '该环境没有这个组件；常见于它还没随解决方案导入到这里。其它环境的结果和对比不受影响。'
  }
  return String(error?.message ?? error ?? '未知错误')
}

/** Render one environment's layer stack. */
function renderEnvironment(result, includeJson) {
  const lines = []
  const groups = groupLayers(result.rows)
  lines.push(
    `### ${result.env.key} — ${result.rows.length} 条层记录，覆盖 ${groups.length} 个组件`
    + `${result.hasMore ? '（已截断，可加 filter 缩小范围）' : ''}`,
  )
  if (!groups.length) {
    lines.push('没有匹配的层记录。组件只在被解决方案承载时才有层；系统内置、未进任何解决方案的组件查不到层。')
    return { lines, groups }
  }

  const summaryRows = groups.map((group) => ({
    组件: group.name,
    类型: group.type,
    层数: group.layers.length,
    活动层: solutionLabel(group.active),
    层序: group.active?.msdyn_order ?? '',
    更新时间: formatTime(group.active?.msdyn_overwritetime),
  }))
  lines.push('')
  lines.push('活动层（层序最大者为当前生效层）：')
  lines.push(formatTable(summaryRows, ['组件', '类型', '层数', '活动层', '层序', '更新时间'], { limit: INLINE_ROWS }))

  const stacked = groups.filter((group) => group.layers.filter((layer) => layer.msdyn_solutionname).length > 1)
  if (stacked.length) {
    lines.push('')
    lines.push(`被多个解决方案覆盖的组件：${stacked.length} 个（这类组件最容易出现环境间不一致）`)
    for (const group of stacked.slice(0, 10)) {
      const chain = group.layers.map((layer) => `${layer.msdyn_order}:${solutionLabel(layer)}`).join(' → ')
      lines.push(`- ${group.name}（${group.type}）：${chain}`)
    }
    if (stacked.length > 10) lines.push(`- … 其余 ${stacked.length - 10} 个见文件`)
  }

  if (includeJson) lines.push('', '各层的 msdyn_componentjson 已写入结果文件（未在此展开，单条可达数百 MB）。')
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

      const results = []
      for (const env of environments) {
        try {
          const client = makeClient(env, config)
          const componentId = await resolveComponentId(client, args, exec?.signal)
          const filter = buildComponentFilter(componentId, args.componentType)
          // No `$orderby`: the virtual provider only guarantees the id+type
          // filter, and ordering is applied after the rows arrive.
          const { page, selectDropped } = await getPagedWithSelectFallback(
            client,
            'msdyn_componentlayers',
            { $select: select, $filter: filter },
            top,
            exec?.signal,
          )
          const rows = args.solution
            ? page.records.filter((row) => row.msdyn_solutionname === args.solution)
            : page.records
          results.push({
            env,
            ok: true,
            componentId,
            rows: rows.sort((a, b) => Number(a.msdyn_order ?? 0) - Number(b.msdyn_order ?? 0)),
            hasMore: page.hasMore,
            selectDropped,
            filter,
          })
        } catch (error) {
          // One environment missing the component must not sink the others:
          // this is the common "component exists in UAT but not in SIT" case.
          results.push({ env, ok: false, error })
        }
      }
      if (results.length && results.every((result) => !result.ok)) throw results[0].error

      const lines = [`查询解决方案层：${environments.map((env) => env.key).join(' / ')}`]
      lines.push(`组件：${args.componentType ?? '?'} / ${args.component ?? '?'}${args.entity ? `（${args.entity}）` : ''}`)
      if (args.solution) lines.push(`只看解决方案：${args.solution}`)

      const perEnv = []
      for (const result of results) {
        lines.push('')
        if (!result.ok) {
          lines.push(`### ${result.env.key} — 查询失败`)
          lines.push(`- ${describeFailure(result.error)}`)
          continue
        }
        const rendered = renderEnvironment(result, args.includeJson)
        lines.push(...rendered.lines)
        if (result.selectDropped) lines.push('（该环境不接受部分 $select 列，已自动降级）')
        perEnv.push({ env: result.env, groups: rendered.groups })
      }

      if (perEnv.length > 1) {
        lines.push('')
        lines.push('### 跨环境对比')
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
            diffs.push(`${name} 有层记录的环境：${present.map((entry) => entry.env).join('/')}；`
              + `无：${absent.map((entry) => entry.env).join('/')}`)
            continue
          }

          // Compare the whole stack, not just the winner: a solution present in
          // one environment shifts every layer above it, which is exactly the
          // drift this comparison is for.
          const stacks = maps.map((entry) => ({
            env: entry.env,
            layers: new Map(entry.map.get(key).layers.map((layer) => [solutionLabel(layer), Number(layer.msdyn_order ?? 0)])),
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
              return `  - 仅 ${bucket.carriers.join('/')} 有（${bucket.solutions.length} 个，${missing.join('/')} 没有）：${bucket.solutions.join('、')}`
            })
            diffs.push(`${name} 层结构不同：\n${detail.join('\n')}`)
          }

          const actives = maps.map((entry) => `${entry.env}=${solutionLabel(entry.map.get(key).active)}`)
          if (new Set(maps.map((entry) => solutionLabel(entry.map.get(key).active))).size > 1) {
            diffs.push(`${name} 活动层不同：${actives.join(' / ')}`)
          }
        }
        if (!diffs.length) lines.push('各环境的层结构与活动层一致。')
        else {
          for (const line of diffs.slice(0, 15)) lines.push(`- ${line}`)
          if (diffs.length > 15) lines.push(`- … 其余 ${diffs.length - 15} 条见文件`)
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
      lines.push('', `完整层数据：${path}`)
      lines.push('说明：层序（msdyn_order）越大越靠上，最大者即当前生效层；系统层表示未由任何解决方案承载。')

      return { text: lines.join('\n') }
    },
    presentCall(args = {}) {
      const envs = args.allEnvironments ? '全部环境' : (args.environments ?? []).join('/') || '默认环境'
      return {
        card: 'generic',
        title: `查询解决方案层${args.component ? `：${args.component}` : ''}（${envs}）`,
        kind: 'other',
        rawInput: args,
      }
    },
  })
}
