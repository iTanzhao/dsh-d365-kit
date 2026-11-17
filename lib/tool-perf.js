/**
 * `d365_perf` — where the time goes.
 *
 * `d365_trace` answers "what failed"; this answers "what is slow, by how much,
 * and since when". Both read the same table; the difference is aggregation,
 * which the server cannot do on a memo column but the client can.
 */
import { loadConfig } from './config.js'
import { D365Error } from './errors.js'
import { makeClient, pickEnvironments, writeArtifact } from './runtime.js'
import { assertRows, formatMs, readSlowRows, renderHotspots, renderSlowest, renderTrend } from './perf.js'

const ACTIONS = ['hotspots', 'slowest', 'trend']

const definition = {
  name: 'd365_perf',
  description:
    '按插件执行耗时做聚合：hotspots 看时间花在哪些插件/消息上（次数、合计、p50/p95/最慢），slowest 看最慢的几条调用，trend 看每小时的变化。'
    + '数据来自 plugintracelogs，属于业务数据，需要「读取业务数据」（data.read）。'
    + '样本上限 5000 条，输出会写明窗口、样本量与跟踪级别——跟踪级别低时成功调用不写日志，这里的分布只代表有记录的那部分。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'hotspots：按插件/消息聚合；slowest：最慢的单次调用；trend：按小时（或天）看趋势。',
      },
      hours: { type: 'number', description: '回看小时数，默认 72，最多 720。' },
      entity: { type: 'string', description: '只看某张表（primaryentity，逻辑名）。' },
      typename: { type: 'string', description: '只看某个插件类型；支持 contains，例如 "ContactSearch"。' },
      message: { type: 'string', description: '只看某个消息（如 Create、Update）。' },
      minDuration: { type: 'number', description: '只看耗时不低于这个毫秒数的调用。' },
      filter: { type: 'string', description: '附加 OData $filter。' },
      top: { type: 'integer', description: '返回多少行/组，默认 20，最多 100。' },
      bucket: { type: 'string', enum: ['hour', 'day'], description: 'trend 的桶大小，默认 hour。' },
      environment: { type: 'string', description: '环境 key，省略则用默认环境。' },
      environments: { type: 'array', items: { type: 'string' }, description: '一次分析多个环境。' },
      allEnvironments: { type: 'boolean', description: '对全部已配置环境执行同一分析。' },
    },
    required: ['action'],
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
      },
    },
    render(_args, value) {
      return [{ type: 'text', text: value?.text ?? '' }]
    },
  },
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args = {}, exec) {
      const config = await loadConfig(state.rawConfig)
      const action = args.action
      if (!ACTIONS.includes(action)) {
        throw new D365Error(`不认识的动作：${action}`, { code: 'bad-action', hint: `可选：${ACTIONS.join(' / ')}` })
      }
      const envs = pickEnvironments(config, args)
      const sections = []
      const artifact = { action, args, environments: {} }

      for (const env of envs) {
        try {
          const client = makeClient(env, config)
          const sample = await readSlowRows(client, args, exec?.signal)
          const rendered = action === 'hotspots'
            ? renderHotspots(env.key, sample, args)
            : action === 'slowest'
              ? renderSlowest(env.key, sample, args)
              : renderTrend(env.key, sample, args)
          assertRows(sample.rows, sample.level)
          artifact.environments[env.key] = {
            hours: sample.hours,
            entity: args.entity,
            filter: sample.filter,
            traceLevel: sample.level ?? null,
            sampled: sample.rows.length,
            capped: sample.capped,
            result: rendered.groups ?? rendered.rows,
          }
          sections.push(rendered.text)
        } catch (error) {
          sections.push([
            `${env.key}：分析失败`,
            `- ${error?.message ?? String(error)}`,
            error?.hint ? `- 建议：${error.hint}` : '',
          ].filter(Boolean).join('\n'))
        }
      }

      const file = await writeArtifact(config, `perf-${action}`, artifact)
      return { schemaVersion: 1, text: `${sections.join('\n\n')}\n\n完整结果：${file}`, artifactPath: file }
    },
    presentCall(args = {}) {
      const envs = args.allEnvironments
        ? '全部环境'
        : [...(args.environments ?? []), args.environment].filter(Boolean).join('/') || '默认环境'
      return {
        card: 'generic',
        title: `插件耗时 ${args.action ?? 'hotspots'}（${envs}）`,
        kind: 'other',
        rawInput: args,
      }
    },
  })
}

export { formatMs }
