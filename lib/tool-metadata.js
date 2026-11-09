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
      name: {
        type: 'string',
        description: '按名称精确取一条记录（目前只有 option_sets 支持：直接按全局选项集名取，一次请求，不用把 900 多个定义都拉下来）。',
      },
      attribute: {
        type: 'string',
        description: 'attributes 资源：只取一个字段（主键读取）。配合 cast 可以读到派生类型才有的列，例如 DefaultValue、OptionSet。',
      },
      cast: {
        type: 'string',
        description: 'attributes 资源：把字段 cast 到派生元数据类型，例如 BooleanAttributeMetadata、PicklistAttributeMetadata、LookupAttributeMetadata、StringAttributeMetadata。只和 attribute 一起用。',
      },
      expand: {
        type: 'string',
        description: '额外的 OData $expand，例如 "plugintypeid($select=typename)"。plugin_steps 默认已展开插件类型与消息名。',
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
        description: '最多返回多少行。省略时清单型资源（插件步骤/类型/镜像、字段）用 1000，其它用配置的 maxRecords。',
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

  // A filter on an endpoint that refuses `$filter` fails at the server with a
  // bare 405 that says nothing about what to do instead.
  if (def.filterable === false && args.filter) {
    throw new D365Error(`${def.summary ?? resource} 不支持 filter`, {
      code: 'filter-unsupported',
      hint: 'Dataverse 的 GlobalOptionSetDefinitions 不接受 $filter（返回 HTTP 405）。'
        + '改成按名称取：{"resource":"option_sets","name":"contoso_taxcategoryos"}；要看全部就不要传 filter。',
    })
  }

  const keyedByName = def.keyedByName && args.name ? def.keyedByName(args.name) : null
  if (args.name && !keyedByName) {
    throw new D365Error(`${def.summary ?? resource} 不支持按名称取单条`, {
      code: 'name-unsupported',
      hint: 'name 目前只用于 option_sets。其它资源用 filter 或 entity 缩小范围。',
    })
  }

  if (args.cast && !args.attribute) {
    throw new D365Error('cast 只能和 attribute 一起用', {
      code: 'cast-without-attribute',
      hint: 'cast 是把单个字段的元数据 cast 到派生类型（例如 {"resource":"attributes","entity":"account","attribute":"donotemail","cast":"BooleanAttributeMetadata"}）。',
    })
  }
  if (args.cast && !/^[A-Za-z]+AttributeMetadata$/.test(args.cast)) {
    throw new D365Error(`cast 看起来不是元数据类型名：${args.cast}`, {
      code: 'bad-cast',
      hint: '要写完整的派生类型名，例如 BooleanAttributeMetadata、PicklistAttributeMetadata、LookupAttributeMetadata。',
    })
  }
  const keyedByAttribute = def.keyedByAttribute && args.attribute ? def.keyedByAttribute(args) : null
  if (args.attribute && !keyedByAttribute) {
    throw new D365Error(`${def.summary ?? resource} 不支持按字段取单条`, {
      code: 'attribute-unsupported',
      hint: 'attribute 目前只用于 attributes（配合 entity）。',
    })
  }

  const keyed = keyedByName ?? keyedByAttribute

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
    path: keyed ?? def.path(args),
    keyed: Boolean(keyed),
    top,
    params: {
      $select: select.length ? [...new Set(select)].join(',') : undefined,
      // A keyed read answers with one object and rejects the collection-only
      // parameters that would otherwise be sent.
      $filter: keyed ? undefined : composeFilter(def, args),
      $orderby: keyed ? undefined : (args.orderby ?? def.orderby),
      $expand: keyed ? undefined : (args.expand ?? def.expand),
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
  } catch {
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
      if (args.name) lines.push(`按名称：${args.name}`)
      const filterText = results.find((item) => item.filter)?.filter
      if (filterText) lines.push(`过滤：${filterText}`)
      if (def?.defaultFilter && !args.filter) {
        lines.push(`说明：默认只列定义行（${def.defaultFilter}）。Dataverse 给每个流程另存一条激活行（type 2，workflowid 不同、名称相同），`
          + '不过滤会看起来像重复、计数也会翻倍；要看激活行请显式传 filter，例如 "type eq 2"。')
      }

      for (const result of results) {
        lines.push('')
        const totalText = result.hasMore && typeof result.total === 'number'
          ? `已列 ${result.rows.length} 条 / 共 ${result.total >= 5000 ? '≥5000' : result.total} 条（未列全，加 filter 或 top 缩小）`
          : `${result.rows.length} 行${result.hasMore ? `（已达上限 ${result.limit}，还有更多；加 filter 或 top 缩小）` : ''}`
        lines.push(`### ${result.env.key} — ${totalText}`)
        if (!result.rows.length) {
          lines.push(args.name
            ? `该环境没有名为 ${args.name} 的${def?.summary ?? resource}（按名称直取返回 404）。`
            : '该环境未返回任何记录。可能确实不存在，也可能是 filter 过窄——先用不带 filter 的查询确认。')
          continue
        }
        const columns = displayColumns(resource, result.rows, args.select)
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
            total: result.total,
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
