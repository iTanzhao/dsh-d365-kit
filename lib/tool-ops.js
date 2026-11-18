/**
 * `d365_diagnose` — one action-typed tool over the three diagnostics that used
 * to be separate tools.
 *
 * `d365_health`, `d365_trace` and `d365_perf` asked the same question from three
 * angles ("is the environment busy", "what failed", "what is slow") and were
 * three entries in the tool list with three overlapping parameter sets. They are
 * merged here behind one `action` enum:
 *
 *   health                                     (was d365_health)
 *   trace-list / trace-get / trace-summary / trace-stages   (was d365_trace)
 *   perf-hotspots / perf-slowest / perf-trend               (was d365_perf)
 *
 * The implementations stay in their own modules (`./tool-health.js`,
 * `./tool-trace.js`, `./tool-perf.js`); this file only dispatches and formats,
 * and it deliberately loads no config — each `run()` reads it once for the
 * actions that need it. All of them read business data (plugintracelogs /
 * asyncoperation and friends), so the read gate is `data.read`.
 *
 * Only `health` returns `rows` (and renders the detail table); every other
 * action returns text and the path of the artifact it wrote.
 */
import { D365Error } from './errors.js'
import { renderHealth } from './health.js'
import { run as runTrace } from './tool-trace.js'
import { run as runPerf } from './tool-perf.js'
import { run as runHealth } from './tool-health.js'

const ACTIONS = [
  'health',
  'trace-list',
  'trace-get',
  'trace-summary',
  'trace-stages',
  'perf-hotspots',
  'perf-slowest',
  'perf-trend',
]

/**
 * One line per environment above the detail table: the table is wide, and a
 * caller reading the transcript wants the counts of each environment first.
 */
function renderHealthText(rows) {
  const list = Array.isArray(rows) ? rows : []
  const lines = list.map((row) => `${row.env}：版本 ${row.version ?? '?'}；挂起 ${row.suspended ?? 0}；失败 ${row.failed ?? 0}${row.denied ? '；无权读取' : ''}`)
  if (list.length) lines.push('（明细见下）')
  return lines.join('\n')
}

export const definition = {
  name: 'd365_diagnose',
  description: '诊断 Dataverse 健康、插件跟踪与性能。读取业务数据，需 data.read；结果仅代表日志窗口内已记录的调用，且凭据会被屏蔽。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'health；trace-list、trace-get、trace-summary、trace-stages；perf-hotspots、perf-slowest、perf-trend。',
      },
      traceId: {
        type: 'string',
        description: 'trace-get / trace-stages 必填：plugintracelogid（GUID，通常来自 trace-list 输出，或 perf-slowest 的 trace 列）。',
      },
      hours: {
        type: 'number',
        description: '回看小时数：health 默认 24；trace-list / trace-summary 默认 24，最多 720；perf-* 默认 72，最多 720。',
      },
      entity: {
        type: 'string',
        description: 'trace-* 与 perf-*：只看某张表（primaryentity，逻辑名，如 account）。',
      },
      typename: {
        type: 'string',
        description: 'trace-* 与 perf-*：只看某个插件类型；支持 contains，例如 "ContactSearch"。',
      },
      message: {
        type: 'string',
        description: 'trace-* 与 perf-*：只看某个消息（messagename，如 Create、Update）。',
      },
      exceptionOnly: {
        type: 'boolean',
        description: 'trace-*：默认 true 只看抛了异常的跟踪；false 连成功执行一起看。',
      },
      includeConfig: {
        type: 'boolean',
        description: 'trace-get 返回配置字段；默认 false，可能含明文密钥。',
      },
      top: {
        type: 'integer',
        description: 'trace-list 返回行数（默认 20，最多 200）；trace-summary 样本上限（默认 300，最多 500）；perf-* 返回行数/组（默认 20，最多 100）。',
      },
      minDuration: {
        type: 'number',
        description: 'perf-*：只看耗时不低于这个毫秒数的调用。',
      },
      filter: {
        type: 'string',
        description: 'perf-*：附加 OData $filter。',
      },
      bucket: {
        type: 'string',
        enum: ['hour', 'day'],
        description: 'perf-trend：桶大小，默认 hour。',
      },
      environment: {
        type: 'string',
        description: 'trace-* 与 perf-*：环境 key，省略则用默认环境；health 请用 environments 或 allEnvironments。',
      },
      environments: {
        type: 'array',
        items: { type: 'string' },
        description: '全部动作：一次查多个环境。',
      },
      allEnvironments: {
        type: 'boolean',
        description: '全部动作：对全部已配置环境执行同一查询。',
      },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['schemaVersion', 'text', 'artifactPath'],
      properties: {
        schemaVersion: { type: 'number' },
        text: { type: 'string' },
        artifactPath: { type: 'string' },
        // Only `health` fills this in; the other actions return text + artifact.
        rows: {
          type: 'array',
          description: '仅 action=health 返回。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              env: { type: 'string' },
              url: { type: 'string' },
              version: { type: 'string' },
              organization: { type: 'string' },
              // -1 means "the server would not tell us", which is not zero.
              queued: { type: 'number' },
              suspended: { type: 'number' },
              failed: { type: 'number' },
              traceLevel: { type: 'number' },
              denied: { type: 'boolean' },
              warnings: { type: 'array', items: { type: 'string' } },
              hours: { type: 'number' },
              failures: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string' },
                    message: { type: 'string' },
                    operationtype: { type: 'number' },
                    modifiedon: { type: 'string' },
                    count: { type: 'number' },
                    errorcode: { type: 'number' },
                  },
                },
              },
              runningSolutions: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string' },
                    operation: { type: 'number' },
                    startedAt: { type: 'string' },
                    managed: { type: 'boolean' },
                  },
                },
              },
              recentSolutions: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    uniquename: { type: 'string' },
                    version: { type: 'string' },
                    managed: { type: 'boolean' },
                    installedon: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    render(_args, value) {
      if (Array.isArray(value?.rows)) return renderHealth(value.rows)
      return [{ type: 'text', text: value?.text ?? '' }]
    },
  },
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args = {}, exec) {
      const action = String(args.action ?? '')

      if (action === 'health') {
        const result = await runHealth(state, args, exec)
        return { ...result, text: renderHealthText(result.rows) }
      }

      if (action.startsWith('trace-')) {
        const result = await runTrace(state, { ...args, action: action.slice('trace-'.length) }, exec)
        return { ...result, schemaVersion: result?.schemaVersion ?? 1 }
      }

      if (action.startsWith('perf-')) {
        const result = await runPerf(state, { ...args, action: action.slice('perf-'.length) }, exec)
        return { ...result, schemaVersion: result?.schemaVersion ?? 1 }
      }

      throw new D365Error(`不认识的操作：${action || '（空）'}`, {
        code: 'bad-action',
        hint: `可选：${ACTIONS.join(' / ')}`,
      })
    },
    presentCall(args = {}) {
      const envs = args.allEnvironments
        ? '全部环境'
        : [...(args.environments ?? []), args.environment].filter(Boolean).join('/') || '默认环境'
      return {
        card: 'generic',
        title: `运行时诊断：${args.action ?? 'health'}（${envs}）`,
        kind: 'other',
        rawInput: args,
      }
    },
  })
}
