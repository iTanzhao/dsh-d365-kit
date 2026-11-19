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
import { t } from './i18n.js'
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
  const lines = list.map((row) => t('diagnose.healthSummary', { env: row.env, version: row.version ?? '?', suspended: row.suspended ?? 0, failed: row.failed ?? 0, denied: row.denied ? t('diagnose.deniedSuffix') : '' }))
  if (list.length) lines.push(t('diagnose.detailsBelow'))
  return lines.join('\n')
}

export const definition = {
  name: 'd365_diagnose',
  description: 'Diagnose Dataverse health, plug-in traces, and performance. Requires data.read; results cover only logged calls and redact credentials.',
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
        description: 'Required for trace-get/trace-stages: plugintracelogid GUID from trace-list or perf-slowest.',
      },
      hours: {
        type: 'number',
        description: 'Lookback hours: health 24; trace-list/trace-summary default 24; perf-* default 72; maximum 720.',
      },
      entity: {
        type: 'string',
        description: 'For trace-* and perf-*: filter to one primaryentity logical name, such as account.',
      },
      typename: {
        type: 'string',
        description: 'For trace-* and perf-*: plug-in type; contains matching is supported, such as "ContactSearch".',
      },
      message: {
        type: 'string',
        description: 'For trace-* and perf-*: message name, such as Create or Update.',
      },
      exceptionOnly: {
        type: 'boolean',
        description: 'For trace-*: defaults to exceptions only; false includes successful executions.',
      },
      includeConfig: {
        type: 'boolean',
        description: 'For trace-get: include configuration, default false; this may expose plaintext secrets.',
      },
      top: {
        type: 'integer',
        description: 'Row limits: trace-list default 20/max 200; trace-summary sample default 300/max 500; perf-* default 20/max 100.',
      },
      minDuration: {
        type: 'number',
        description: 'For perf-*: only calls at or above this duration in milliseconds.',
      },
      filter: {
        type: 'string',
        description: 'For perf-*: additional OData $filter.',
      },
      bucket: {
        type: 'string',
        enum: ['hour', 'day'],
        description: 'For perf-trend: bucket size, default hour.',
      },
      environment: {
        type: 'string',
        description: 'For trace-* and perf-*: environment key, defaulting to configured. For health, use environments/allEnvironments.',
      },
      environments: {
        type: 'array',
        items: { type: 'string' },
        description: 'All actions: query multiple environments.',
      },
      allEnvironments: {
        type: 'boolean',
        description: 'All actions: run the same query in every configured environment.',
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
          description: 'Returned only for action=health.',
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

      throw new D365Error(t('diagnose.badAction', { action: action || t('common.empty') }), {
        code: 'bad-action',
        hint: t('diagnose.actions', { values: ACTIONS.join(' / ') }),
      })
    },
    presentCall(args = {}) {
      const envs = args.allEnvironments
        ? t('common.allEnvironments')
        : [...(args.environments ?? []), args.environment].filter(Boolean).join('/') || t('common.defaultEnvironment')
      return {
        card: 'generic',
        title: t('diagnose.title', { action: args.action ?? 'health', envs }),
        kind: 'other',
        rawInput: args,
      }
    },
  })
}
