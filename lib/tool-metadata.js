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
  makeClient,
  pickEnvironments,
  writeArtifact,
} from './runtime.js'
import { RESOURCES, RESOURCE_KEYS, composeFilter, flattenLabels, odataString } from './resources.js'
import { getPagedWithSelectFallback } from './client.js'
import { D365Error } from './errors.js'

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
  workflows: ['name', 'category', 'statecode', 'primaryentity', 'modifiedon'],
  business_rules: ['name', 'statecode', 'primaryentity', 'modifiedon'],
  plugin_assemblies: ['name', 'version', 'isolationmode', 'sourcetype'],
  plugin_types: ['typename', 'friendlyname'],
  plugin_steps: ['name', 'stage', 'mode', 'rank', 'filteringattributes'],
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
    '以只读方式查询 D365 CE / Dataverse 元数据（实体、字段、表单、视图、工作流、插件、Web 资源、解决方案等）。'
    + '可一次指定多个环境，自动按名称对齐并给出跨环境差异。返回摘要与完整结果文件路径。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['resource'],
    properties: {
      resource: {
        type: 'string',
        enum: RESOURCE_KEYS,
        description: '要查询的元数据类别。选错时会返回完整可选列表。',
      },
      entity: {
        type: 'string',
        description: '实体逻辑名（如 account、new_order），用于 attributes/keys/relationships/forms/views/workflows 等按实体取数的资源。',
      },
      filter: {
        type: 'string',
        description: "额外的 OData $filter 表达式，不带 '$filter='，例如 \"contains(name,'审批')\"。",
      },
      select: {
        type: 'string',
        description: '额外要返回的列，逗号分隔，例如 "formxml,description"。列名写错会先自动降级重试。',
      },
      orderby: {
        type: 'string',
        description: '覆盖默认排序，例如 "modifiedon desc"。',
      },
      top: {
        type: 'integer',
        description: '最多返回多少行。默认取配置的 maxRecords。',
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
      save: {
        type: 'boolean',
        description: '强制把完整结果写入文件（默认仅在超过 12 行时写）。',
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
function displayColumns(resource, rows) {
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
    throw new D365Error(`未知的元数据类别：${resource}`, {
      code: 'unknown-resource',
      hint: `可用：${RESOURCE_KEYS.join(', ')}`,
    })
  }
  if (def.entityScoped && !args.entity) {
    throw new D365Error(`查询 ${resource} 需要 entity 参数`, {
      code: 'missing-entity',
      hint: `传入实体逻辑名，例如 {"resource":"${resource}","entity":"account"}`,
    })
  }

  const select = [def.select, args.select]
    .filter(Boolean)
    .join(',')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  const top = Number.isFinite(args.top) ? Math.max(1, Math.min(5000, Math.trunc(args.top))) : config.maxRecords

  return {
    path: def.path(args),
    params: {
      $select: select.length ? [...new Set(select)].join(',') : undefined,
      $filter: composeFilter(def, args),
      $orderby: args.orderby ?? def.orderby,
    },
    top,
  }
}

/** Query one environment and return rows plus provenance. */
async function queryEnvironment(env, config, args, signal) {
  const request = buildRequest(args.resource, args, config)
  const client = makeClient(env, config)
  const started = Date.now()
  const { page, selectDropped } = await getPagedWithSelectFallback(
    client,
    request.path,
    request.params,
    request.top,
    signal,
  )
  const rows = page.records.map((row) => flattenLabels(row))
  // The organization table has no portable `version` column; take it from the
  // supported RetrieveVersion action so the resource still reports it.
  if (args.resource === 'organization' && rows.length) {
    const version = await client.readVersion(signal)
    if (version) rows[0] = { ...rows[0], version }
  }
  return {
    env,
    rows,
    hasMore: page.hasMore,
    selectDropped,
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

      const results = []
      for (const env of environments) {
        results.push(await queryEnvironment(env, config, args, exec?.signal))
      }

      const lines = []
      lines.push(`查询 ${def?.summary ?? resource}：${environments.map((env) => env.key).join(' / ')}`)
      if (args.entity) lines.push(`实体：${args.entity}`)
      const filterText = results.find((item) => item.filter)?.filter
      if (filterText) lines.push(`过滤：${filterText}`)

      for (const result of results) {
        lines.push('')
        lines.push(`### ${result.env.key} — ${result.rows.length} 行${result.hasMore ? '（还有更多，可加 top 或 filter）' : ''}`)
        if (!result.rows.length) {
          lines.push('该环境未返回任何记录。可能确实不存在，也可能是 filter 过窄——先用不带 filter 的查询确认。')
          continue
        }
        const columns = displayColumns(resource, result.rows)
        lines.push(formatTable(result.rows, columns, { limit: INLINE_ROWS }))
        if (result.selectDropped) lines.push('（该环境不接受部分 $select 列，已自动去掉后重试，故列数可能偏少）')
      }

      const comparison = compareEnvironments(resource, results.map((result) => ({ env: result.env, rows: result.rows })))
      if (comparison) {
        lines.push('')
        lines.push('### 跨环境对比')
        lines.push(...comparison.lines)
      }

      const totalRows = results.reduce((sum, result) => sum + result.rows.length, 0)
      const shouldSave = args.save === true || totalRows > INLINE_ROWS
      if (shouldSave) {
        const path = await writeArtifact(config, `${resource}-${environments.map((env) => env.key).join('-')}`, {
          resource,
          args,
          generatedAt: new Date().toISOString(),
          environments: results.map((result) => ({
            env: result.env.key,
            url: result.env.url,
            count: result.rows.length,
            hasMore: result.hasMore,
            requests: result.requests,
            elapsedMs: result.elapsedMs,
            filter: result.filter,
            rows: result.rows,
          })),
          comparison: comparison ? { changed: comparison.changed, onlyIn: [...comparison.onlyIn.values()] } : undefined,
        })
        lines.push('')
        lines.push(`完整结果：${path}`)
      }

      return { text: lines.join('\n') }
    },
    presentCall(args = {}) {
      const envs = args.allEnvironments
        ? '全部环境'
        : [...(args.environments ?? []), args.environment].filter(Boolean).join('/') || '默认环境'
      return {
        card: 'generic',
        title: `查询 ${args.resource}${args.entity ? `：${args.entity}` : ''}（${envs}）`,
        kind: 'other',
        rawInput: args,
      }
    },
  })
}
