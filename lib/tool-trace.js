/**
 * `d365_trace` — read plug-in trace logs, the record of what a plug-in actually
 * saw and did.
 *
 * Metadata says which step is registered; only a trace says why it threw. The
 * three actions answer the three questions that come up in that order:
 *
 *   list     what ran (and failed) in a window
 *   get      what one trace contains — exception, message block, timings
 *   summary  which failures repeat, and whether tracing is even switched on
 *
 * Trace rows are business data, not metadata: they carry record ids, payload
 * XML and sometimes credentials in the secure configuration. They are gated by
 * `data.read` for that reason, and `get` leaves the configuration fields out
 * unless asked for them.
 */
import { loadConfig } from './config.js'
import { formatTable, makeClient, pickEnvironments, writeArtifact } from './runtime.js'
import { D365Error } from './errors.js'

const ACTIONS = ['list', 'get', 'summary']
const CONFIG_FIELDS = ['configuration', 'secureconfiguration', 'profile']

// `operationtypename` / `modename` are not selectable on plugintracelog (the
// server answers 0x80060888), so the list keeps to columns that exist: the
// message name, the plug-in type and the exception are what identify a run.
const LIST_SELECT = [
  'plugintracelogid',
  'typename',
  'messagename',
  'primaryentity',
  'depth',
  'performanceexecutionduration',
  'performanceexecutionstarttime',
  'exceptiondetails',
].join(',')

/**
 * First line of an exception, normalised enough to group by.
 *
 * Dataverse writes the type and message on the first line and the stack below
 * it; the stack is what differs between two occurrences of the same bug.
 */
export function exceptionSignature(text) {
  const value = String(text ?? '').replace(/\r/g, '')
  if (!value.trim()) return ''
  const line = value
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith('at ')) ?? ''
  return line.length > 160 ? `${line.slice(0, 160)}…` : line
}

/**
 * Short type name.
 *
 * `typename` is assembly-qualified (`Contoso.Plugins.X, Contoso.Plugins,
 * Version=1.0.0.0, Culture=neutral, PublicKeyToken=...`), so splitting on `.`
 * alone produces assembly noise instead of the class name.
 */
function shortTypeName(value) {
  const text = String(value ?? '').trim()
  if (!text) return '—'
  const withoutAssembly = text.split(',')[0].trim()
  const parts = withoutAssembly.split('.')
  return parts[parts.length - 1] || withoutAssembly
}

/**
 * Mask credentials that plug-ins wrote into their own trace.
 *
 * Real traces embed `secureConfig:{"ClientId": "…", "ClientSecret": "…"}` and
 * `Authorization: Bearer …` inside the message block. The log itself is on the
 * server; this redaction keeps the secret out of the chat transcript and the
 * local artifact, which travel much further.
 * @returns the masked text plus how many values were replaced.
 */
export function redactSecrets(input) {
  let count = 0
  const text = String(input ?? '')
    .replace(/("(?:[A-Za-z0-9_]*(?:secret|password|pwd|token|apikey|api_key|authorization)[A-Za-z0-9_]*)"\s*:\s*")([^"]*)(")/gi,
      (_match, head, _value, tail) => {
        count += 1
        return `${head}***${tail}`
      })
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"',]+/gi, (_match, head) => {
      count += 1
      return `${head}***`
    })
  return { text, count }
}

/** Shorten a duration in milliseconds for the inline table. */
function formatDuration(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return '—'
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`
}

function shortTime(value) {
  const text = String(value ?? '')
  return text.length >= 19 ? text.slice(0, 19).replace('T', ' ') : text || '—'
}

async function readTraceLevel(client, signal) {
  try {
    const org = await client.getOne('organizations', { $select: 'plugintracelogsetting' }, signal)
    const level = Number(org?.plugintracelogsetting)
    return Number.isFinite(level) ? level : undefined
  } catch {
    return undefined
  }
}

function traceLevelNote(level) {
  if (level === undefined) return null
  if (level === 0) {
    return '注意：该环境的插件跟踪级别是「关闭」。插件异常只会写进系统作业，不会写跟踪日志——查不到日志通常就是这个原因。'
  }
  if (level === 1) return '插件跟踪级别：「仅异常」。只有抛异常的执行才会留下日志，成功执行不记录。'
  return null
}

export const definition = {
  name: 'd365_trace',
  description:
    'Read plug-in trace logs: what ran and failed in a window (list), what one trace contains (get), or which failures repeat (summary). '
    + 'Use it after a step fails: metadata tells you the step is registered, only the trace says why it threw. '
    + 'Trace rows are business data (they contain record ids, payload XML and sometimes secrets), so this needs "读取业务数据" (data.read). '
    + 'Credentials that plug-ins wrote into their own trace are masked before anything is shown.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'list：窗口内的跟踪列表；get：一条跟踪的完整内容；summary：按异常签名汇总，并检查跟踪是否开启。',
      },
      traceId: {
        type: 'string',
        description: 'action=get 时必填：plugintracelogid（GUID，通常来自 list 输出）。',
      },
      hours: {
        type: 'integer',
        description: 'list/summary 的回看小时数，默认 24。',
      },
      entity: {
        type: 'string',
        description: '只看某张表上的跟踪（primaryentity，逻辑名，如 account）。',
      },
      typename: {
        type: 'string',
        description: '只看某个插件类型的跟踪；支持 contains，例如 "ContactSearch"。',
      },
      message: {
        type: 'string',
        description: '只看某个消息的跟踪（messagename，如 Create、Update）。',
      },
      exceptionOnly: {
        type: 'boolean',
        description: '默认 true：只看抛了异常的跟踪。传 false 连成功执行一起看。',
      },
      includeConfig: {
        type: 'boolean',
        description: 'action=get：是否返回 configuration / secureconfiguration / profile（默认 false，这些字段可能含明文密钥）。',
      },
      top: {
        type: 'integer',
        description: 'list 返回行数（默认 20，最多 200）；summary 分析的样本上限（默认 300，最多 500）。',
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

function buildFilter(args, sinceIso) {
  const parts = [`createdon ge ${sinceIso}`]
  // A successful trace stores an empty string, not null, so `ne null` alone
  // still matches it — that is how a "failures only" list came back with clean
  // runs.
  if (args.exceptionOnly !== false) parts.push('exceptiondetails ne null', "exceptiondetails ne ''")
  if (args.entity) parts.push(`primaryentity eq '${String(args.entity).replace(/'/g, "''")}'`)
  if (args.message) parts.push(`messagename eq '${String(args.message).replace(/'/g, "''")}'`)
  if (args.typename) {
    const value = String(args.typename).replace(/'/g, "''")
    parts.push(`contains(typename,'${value}')`)
  }
  return parts.join(' and ')
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
      if (action === 'get' && !String(args.traceId ?? '').trim()) {
        throw new D365Error('action=get 需要 traceId', {
          code: 'missing-trace-id',
          hint: '先跑 action=list，把输出里的 plugintracelogid 传进来。',
        })
      }

      const envs = pickEnvironments(config, args)
      const hours = Number.isFinite(args.hours) ? Math.max(1, Math.min(24 * 30, args.hours)) : 24
      const sinceIso = new Date(Date.now() - hours * 3600_000).toISOString()
      const reports = []
      const artifact = { action, hours, filter: undefined, environments: {} }

      for (const env of envs) {
        const client = makeClient(env, config)
        const level = await readTraceLevel(client, exec?.signal)
        const note = traceLevelNote(level)

        if (action === 'get') {
          const id = String(args.traceId).trim()
          const params = {}
          const rows = await client.requestJson(
            client.buildUrl(`plugintracelogs(${id})`, params),
            { signal: exec?.signal },
          ).catch((error) => {
            if (error?.status === 404) {
              throw new D365Error(`${env.key} 没有 id 为 ${id} 的跟踪记录`, {
                code: 'trace-not-found',
                hint: '跟踪日志会按组织设置被清理；确认 id 属于这个环境，或换一个时间窗口重新 list。',
              })
            }
            throw error
          })
          const row = Array.isArray(rows?.value) ? rows.value[0] : rows
          if (!row) throw new D365Error(`${env.key} 没有返回跟踪 ${id}`, { code: 'trace-not-found' })
          if (!args.includeConfig) {
            for (const field of CONFIG_FIELDS) delete row[field]
          }
          // Plug-ins write their own credentials into the message block; mask
          // them before this text becomes a transcript and a local artifact.
          let masked = 0
          for (const field of ['messageblock', 'exceptiondetails', 'configuration', 'secureconfiguration', 'profile']) {
            if (typeof row[field] !== 'string') continue
            const result = redactSecrets(row[field])
            row[field] = result.text
            masked += result.count
          }
          artifact.environments[env.key] = { traceLevel: level ?? null, trace: row, maskedValues: masked }
          const blocks = [
            `${env.key}：跟踪 ${id}`,
            `- 插件类型：${row.typename ?? '—'}`,
            `- 消息 / 表：${row.messagename ?? '—'} / ${row.primaryentity ?? '—'}`,
            `- 深度：${row.depth ?? '—'}`,
            `- 执行耗时：${formatDuration(row.performanceexecutionduration)}（开始 ${shortTime(row.performanceexecutionstarttime)}）`,
          ]
          if (row.exceptiondetails) {
            blocks.push('', '异常：', String(row.exceptiondetails).slice(0, 3000))
          } else {
            blocks.push('', '异常：无（这次执行没有抛异常）')
          }
          if (row.messageblock) {
            blocks.push('', '请求内容（messageblock）：', String(row.messageblock).slice(0, 4000))
          }
          if (masked > 0) {
            blocks.push('', `（已屏蔽 ${masked} 处疑似密钥；原值仍在环境里的跟踪日志中，这里不回显。）`)
          }
          if (note) blocks.push('', note)
          if (!args.includeConfig) {
            blocks.push('', '（configuration / secureconfiguration / profile 未返回；需要时传 includeConfig: true，注意其中可能有明文密钥。）')
          }
          reports.push(blocks.join('\n'))
          continue
        }

        const filter = buildFilter(args, sinceIso)
        artifact.filter = filter

        if (action === 'list') {
          const top = Number.isFinite(args.top) ? Math.max(1, Math.min(200, args.top)) : 20
          const page = await client.getPaged('plugintracelogs', {
            $select: LIST_SELECT,
            $filter: filter,
            $orderby: 'createdon desc',
          }, top, exec?.signal)
          const rows = page.records ?? []
          artifact.environments[env.key] = { traceLevel: level ?? null, rows, hasMore: page.hasMore }
          const table = rows.length
            ? formatTable(rows.map((row) => ({
              ...row,
              typename: row.typename ?? '—',
              'plugin/message': `${shortTypeName(row.typename)} / ${row.messagename ?? '—'}`,
              at: shortTime(row.performanceexecutionstarttime),
              duration: formatDuration(row.performanceexecutionduration),
              exception: exceptionSignature(row.exceptiondetails) || '—',
            })), ['at', 'plugin/message', 'primaryentity', 'duration', 'exception'], { width: 44 })
            : '（这个窗口里没有匹配的跟踪记录）'
          const head = rows.length
            ? `${env.key}：最近 ${hours} 小时${args.exceptionOnly === false ? '' : '失败'}跟踪，返回 ${rows.length} 条${page.hasMore ? '（已达上限，缩小时间窗口或加 entity / typename）' : ''}`
            : `${env.key}：最近 ${hours} 小时没有${args.exceptionOnly === false ? '' : '失败的'}跟踪记录`
          reports.push([head, table, note].filter(Boolean).join('\n'))
          continue
        }

        // summary: pull a bounded sample of failures and aggregate by signature
        // locally — a memo column (exceptiondetails) cannot be grouped
        // server-side.
        const limit = Number.isFinite(args.top) ? Math.max(1, Math.min(500, args.top)) : 300
        const page = await client.getPaged('plugintracelogs', {
          $select: 'plugintracelogid,typename,messagename,primaryentity,exceptiondetails,performanceexecutionstarttime',
          $filter: buildFilter({ ...args, exceptionOnly: true }, sinceIso),
          $orderby: 'createdon desc',
        }, limit, exec?.signal)
        const rows = page.records ?? []
        const groups = new Map()
        for (const row of rows) {
          const signature = exceptionSignature(row.exceptiondetails)
          const key = `${row.typename ?? ''}|${row.messagename ?? ''}|${row.primaryentity ?? ''}|${signature}`
          const entry = groups.get(key) ?? {
            typename: row.typename ?? '—',
            message: row.messagename ?? '—',
            entity: row.primaryentity ?? '—',
            signature: signature || '—',
            count: 0,
            first: shortTime(row.performanceexecutionstarttime),
            last: shortTime(row.performanceexecutionstarttime),
            sampleId: row.plugintracelogid,
          }
          entry.count += 1
          const at = shortTime(row.performanceexecutionstarttime)
          if (at < entry.first) entry.first = at
          if (at > entry.last) entry.last = at
          groups.set(key, entry)
        }
        const summary = [...groups.values()].sort((a, b) => b.count - a.count)
        // Distinguish "no traces at all" from "traces, but none failed".
        let anyTraces = rows.length > 0
        if (!anyTraces) {
          const probe = await client.getPaged('plugintracelogs', {
            $select: 'plugintracelogid',
            $filter: `createdon ge ${sinceIso}`,
          }, 1, exec?.signal).catch(() => ({ records: [] }))
          anyTraces = (probe.records ?? []).length > 0
        }
        artifact.environments[env.key] = {
          traceLevel: level ?? null,
          sampled: rows.length,
          failures: rows.length,
          signatures: summary,
        }
        const head = rows.length === 0
          ? anyTraces
            ? `${env.key}：最近 ${hours} 小时有跟踪记录，但没有带异常的`
            : `${env.key}：最近 ${hours} 小时没有任何跟踪记录`
          : `${env.key}：最近 ${hours} 小时 ${rows.length} 条失败跟踪，归为 ${summary.length} 个签名`
        const table = summary.length
          ? formatTable(summary.map((item) => ({
            ...item,
            'plugin/message': `${shortTypeName(item.typename)} / ${item.message}`,
            signature: item.signature,
          })), ['count', 'plugin/message', 'entity', 'signature', 'last'], { width: 40 })
          : ''
        const tips = []
        if (note) tips.push(note)
        if (anyTraces && !rows.length) {
          tips.push('窗口内没有异常跟踪。若你在查一个失败，确认消息 / 表 / 插件类型过滤没有把它排除，或把 hours 放大。')
        }
        if (summary.length === 1) {
          tips.push(`只有一个签名：先看它的样例 trace（action=get traceId="${summary[0].sampleId}"）。`)
        }
        reports.push([head, table, ...tips].filter(Boolean).join('\n'))
      }

      const file = await writeArtifact(config, `trace-${action}`, artifact)
      return { text: `${reports.join('\n\n')}\n\n完整结果：${file}` }
    },
  })
}
