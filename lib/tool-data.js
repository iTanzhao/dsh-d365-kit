/**
 * `d365_data` — the data half of "who uses this".
 *
 * Metadata references say a field is on a form; they do not say whether 12 or
 * 120000 records carry a value in it. Before deleting a field or an option
 * value, the count is the part that decides. Every read here goes through the
 * normal client, so it is refused unless the environment grants `data.read`.
 *
 * Aggregation uses OData `$apply`, which Dataverse supports on ordinary entity
 * sets; when a server rejects it the tool falls back to paging and counting.
 */
import { loadConfig } from './config.js'
import { formatTable, makeClient, pickEnvironments, writeArtifact } from './runtime.js'
import { getPagedWithSelectFallback } from './client.js'
import { D365Error } from './errors.js'
import { odataString } from './resources.js'

const ACTIONS = ['count', 'group', 'sample', 'query']

export const definition = {
  name: 'd365_data',
  description:
    'Read business records: count them, group them by a column, sample a few rows, or run one query with your own columns / sort / expand / id. '
    + 'Use it to judge impact before changing metadata, or to fetch the exact rows a later write needs. '
    + 'Requires the environment to grant "读取业务数据" (data.read); metadata reads have their own "读取元数据" switch, on by default.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'entity'],
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'count：总行数；group：按某列分组计数；sample：取几行看样例；query：按 select / orderby / expand / id 取具体行。',
      },
      entity: {
        type: 'string',
        description: '实体逻辑名（如 account）或集合名（如 accounts）。',
      },
      filter: {
        type: 'string',
        description: "OData $filter，不带 '$filter='，例如 \"statecode eq 0\"。",
      },
      field: {
        type: 'string',
        description: 'action=group 时必填：用来分组的列逻辑名，例如 contoso_taxcategory。',
      },
      select: {
        type: 'string',
        description: 'action=sample/query 时要返回的列，逗号分隔；sample 省略则取前 5 列，query 省略则取返回行实际带的列。',
      },
      orderby: {
        type: 'string',
        description: "action=query 的排序，例如 \"modifiedon desc\"。",
      },
      expand: {
        type: 'string',
        description: 'action=query 的 $expand，例如 "primarycontactid($select=fullname)"。',
      },
      id: {
        type: 'string',
        description: 'action=query：按主键取一条（GUID，或带引号的备用键值如 \'contoso_001\'）。',
      },
      top: {
        type: 'integer',
        description: 'action=sample 返回行数（默认 5，最多 100）；action=group 返回前 N 组（默认 20）；action=query 返回行数（默认 25，最多 500）。',
      },
      environment: {
        type: 'string',
        description: '环境 key，省略则用默认环境。',
      },
      environments: {
        type: 'array',
        items: { type: 'string' },
        description: '一次查多个环境。',
      },
      allEnvironments: {
        type: 'boolean',
        description: '对全部已配置环境执行同一查询。',
      },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
    render(_args, value) {
      return [{ type: 'text', text: value?.text ?? '' }]
    },
  },
}

/**
 * Resolve the entity set name.
 *
 * EntitySetName is customisable, so guessing `${entity}s` is only a fallback:
 * the metadata read is authoritative and cheap.
 * @returns the collection path segment.
 */
export async function resolveEntitySet(client, entity, signal) {
  const candidate = String(entity).trim()
  if (!candidate) throw new D365Error('entity 不能为空', { code: 'missing-entity' })
  // Keyed metadata paths reject `$top`, so ask the collection form instead —
  // the same shape `d365_metadata` already uses successfully.
  try {
    const result = await getPagedWithSelectFallback(client, 'EntityDefinitions', {
      $select: 'LogicalName,EntitySetName,PrimaryIdAttribute',
      $filter: `LogicalName eq '${candidate}'`,
    }, 2, signal)
    const row = result?.page?.records?.[0]
    if (row?.EntitySetName) {
      return { set: row.EntitySetName, logical: row.LogicalName ?? candidate, idField: row.PrimaryIdAttribute }
    }
  } catch (error) {
    // Only a rejected query means "no such entity"; auth failures, timeouts
    // and the like must surface as themselves, not as a misleading 404.
    if (error?.status !== 400 && error?.status !== 404 && error?.code !== 'unknown-entity') throw error
  }
  if (!/s$/.test(candidate)) {
    throw new D365Error(`实体不存在：${candidate}`, {
      code: 'unknown-entity',
      hint: '用实体逻辑名（如 contoso_systemconfiguration）或集合名（如 contoso_systemconfigurations）。',
    })
  }
  return { set: candidate, logical: candidate }
}

/** Count rows, using `$apply` first and `$count=true` as a fallback. */
async function countRows(client, set, filter, signal) {
  const params = filter ? { $filter: filter } : {}
  try {
    const page = await client.getPaged(set, { ...params, $apply: 'aggregate($count as count)' }, 5, signal)
    const value = page.records?.[0]?.count
    if (typeof value === 'number') return value
  } catch (error) {
    // A permission refusal is not "this set rejects $apply" — surface it.
    if (error?.code === 'data-read-forbidden') throw error
  }
  try {
    const page = await client.requestJson(
      client.buildUrl(set, { ...params, $count: 'true', $top: '1' }),
      { signal },
    )
    if (typeof page?.['@odata.count'] === 'number') return page['@odata.count']
  } catch (error) {
    if (error?.code === 'data-read-forbidden') throw error
  }
  throw new D365Error(`无法统计 ${set} 的行数`, {
    code: 'count-unavailable',
    hint: '该表可能不支持聚合查询；用 filter 缩小范围后重试，或改用 action=sample。',
  })
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args, exec) {
      const config = await loadConfig(state.rawConfig)
      const action = args.action
      if (!ACTIONS.includes(action)) {
        throw new D365Error(`不认识的操作：${action}`, { code: 'unknown-action', hint: `可选：${ACTIONS.join(' / ')}` })
      }
      if (action === 'group' && !args.field) {
        throw new D365Error('action=group 需要 field', { code: 'missing-field' })
      }

      const envs = pickEnvironments(config, args)
      const reports = []
      const artifact = { action, entity: args.entity, filter: args.filter, environments: {} }

      for (const env of envs) {
        const client = makeClient(env, config)
        const { set, logical } = await resolveEntitySet(client, args.entity, exec?.signal)
        const filter = args.filter

        if (action === 'count') {
          const count = await countRows(client, set, filter, exec?.signal)
          artifact.environments[env.key] = { entitySet: set, count }
          reports.push(`${env.key}：${logical} 共 ${count} 行${filter ? `（筛选：${filter}）` : ''}`)
          continue
        }

        if (action === 'group') {
          const apply = `groupby((${args.field}),aggregate($count as count))`
          const page = await client.getPaged(set, {
            ...(filter ? { $filter: filter } : {}),
            $apply: apply,
          }, Number.isFinite(args.top) ? Math.max(1, Math.min(500, args.top)) : 20, exec?.signal)
          const rows = page.records ?? []
          const display = rows.map((row) => ({ ...row, [args.field]: row[args.field] ?? '（空）' }))
          const total = rows.reduce((sum, row) => sum + (row.count ?? 0), 0)
          artifact.environments[env.key] = { entitySet: set, field: args.field, groups: rows }
          const table = formatTable(display, [args.field, 'count'], { width: 46 })
          reports.push(`${env.key}：按 ${args.field} 分组，前 ${rows.length} 组合计 ${total} 行\n${table}`)
          continue
        }

        if (action === 'query') {
          const top = Number.isFinite(args.top) ? Math.max(1, Math.min(500, args.top)) : 25
          const columns = args.select
            ? args.select.split(',').map((item) => item.trim()).filter(Boolean)
            : null
          if (args.id !== undefined && args.id !== null && String(args.id).trim()) {
            const key = String(args.id).trim()
            const bare = key.replace(/^'|'$/g, '')
            if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(bare) && !/^'.*'$/.test(key)) {
              throw new D365Error(`id 既不是 GUID 也不是带引号的备用键：${key}`, {
                code: 'bad-id',
                hint: "主键传 GUID；备用键要带单引号，例如 \"contoso_001\" 写成 \"'contoso_001'\"。",
              })
            }
            const params = {}
            if (args.select) params.$select = args.select
            if (args.expand) params.$expand = args.expand
            let row
            try {
              row = await client.requestJson(client.buildUrl(`${set}(${key})`, params), { signal: exec?.signal })
            } catch (error) {
              if (error?.status === 404) {
                throw new D365Error(`${env.key} 里没有 ${logical}(${key}) 这条记录`, {
                  code: 'record-not-found',
                  hint: '确认 id 属于这个环境；跨环境复制过来的 GUID 在目标不存在时也会是 404。',
                })
              }
              throw error
            }
            if (!row || typeof row !== 'object') {
              throw new D365Error(`${env.key} 没有返回 ${logical}(${key})`, { code: 'record-not-found' })
            }
            artifact.environments[env.key] = { entitySet: set, id: key, rows: [row] }
            const shown = columns ?? Object.keys(row).filter((name) => !name.startsWith('@')).slice(0, 8)
            reports.push(`${env.key}：${logical}(${key})\n${formatTable([row], shown, { width: 40 })}`)
            continue
          }
          // Do not send `$top` here: `getPaged` asks for one row more than the
          // cap so a full page is distinguishable from a complete one.
          const params = {}
          if (filter) params.$filter = filter
          if (args.select) params.$select = args.select
          if (args.orderby) params.$orderby = args.orderby
          if (args.expand) params.$expand = args.expand
          const page = await client.getPaged(set, params, top, exec?.signal)
          const rows = page.records ?? []
          const total = page.hasMore ? await countRows(client, set, filter, exec?.signal).catch(() => undefined) : rows.length
          const shown = columns ?? Object.keys(rows[0] ?? {}).filter((name) => !name.startsWith('@')).slice(0, 8)
          artifact.environments[env.key] = { entitySet: set, params, total, rows }
          const head = total === undefined
            ? `${env.key}：${logical} 返回 ${rows.length} 行（可能还有更多）`
            : total === rows.length
              ? `${env.key}：${logical} 共 ${total} 行`
              : `${env.key}：已列 ${rows.length} 条 / 共 ${total} 条（未列全，加 filter 或调 top）`
          reports.push(`${head}\n${formatTable(rows, shown, { width: 40 })}`)
          continue
        }

        const top = Number.isFinite(args.top) ? Math.max(1, Math.min(100, args.top)) : 5
        const params = { $top: top }
        if (filter) params.$filter = filter
        if (args.select) params.$select = args.select
        const page = await client.getPaged(set, params, top, exec?.signal)
        const rows = page.records ?? []
        const columns = args.select ? args.select.split(',').map((item) => item.trim()) : Object.keys(rows[0] ?? {}).slice(0, 5)
        artifact.environments[env.key] = { entitySet: set, rows }
        reports.push(`${env.key}：${logical} 样例 ${rows.length} 行\n${formatTable(rows, columns, { width: 32 })}`)
      }

      const file = await writeArtifact(config, `data-${action}`, artifact)
      return { text: `${reports.join('\n\n')}\n\n完整结果：${file}` }
    },
  })
}
