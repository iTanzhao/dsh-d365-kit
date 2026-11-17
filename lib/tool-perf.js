/**
 * Implementation behind `d365_diagnose` (the `perf-*` actions) — where the time
 * goes.
 *
 * The `trace-*` actions answer "what failed"; this answers "what is slow, by
 * how much, and since when". Both read the same table; the difference is
 * aggregation, which the server cannot do on a memo column but the client can.
 */
import { loadConfig } from './config.js'
import { D365Error } from './errors.js'
import { makeClient, pickEnvironments, writeArtifact } from './runtime.js'
import { assertRows, formatMs, readSlowRows, renderHotspots, renderSlowest, renderTrend } from './perf.js'

const ACTIONS = ['hotspots', 'slowest', 'trend']

export async function run(state, args = {}, exec) {
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
}

export { formatMs }
