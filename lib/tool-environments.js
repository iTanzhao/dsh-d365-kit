/**
 * `d365_envs` — what environments exist, and can they actually be reached.
 *
 * This is the first tool a person should call: it answers "what am I connected
 * to" before any metadata question, and it separates "not configured" from
 * "configured but the secret is missing" from "configured but unreachable".
 */
import { loadConfig } from './config.js'
import { environmentStatus } from './runtime.js'

export const definition = {
  name: 'd365_envs',
  description:
    '列出已配置的 D365 CE 环境、凭据是否齐全，并在 check=true 时真实调用一次 Web API 验证连通性。'
    + '在回答任何"某个环境里有没有 X"之前先调用它，避免把"没配置"误说成"环境里没有"。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      check: {
        type: 'boolean',
        description: '是否真的连接每个环境验证（会消耗少量 Web API 请求）。默认 false，只做本地配置检查。',
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
 * Format the status report.
 * @param config - normalized config.
 * @param report - rows from `environmentStatus`.
 * @returns printable text.
 */
function renderReport(config, report) {
  const lines = []
  lines.push(`已配置 ${report.length} 个环境，默认环境：${config.defaultEnvironment ?? '（无）'}`)

  for (const row of report) {
    const { env } = row
    const tag = env.key === config.defaultEnvironment ? '（默认）' : ''
    const auth = row.complete ? '凭据齐全' : '凭据不全'
    const reach = row.reachable === undefined ? '' : row.reachable ? '，连接正常' : '，连接失败'
    lines.push('')
    lines.push(`### ${env.key}${tag}${env.label && env.label !== env.key ? ` — ${env.label}` : ''}`)
    lines.push(`- URL：${env.url}`)
    lines.push(`- 云：${env.cloud}${env.note ? `；备注：${env.note}` : ''}`)
    lines.push(`- 状态：${auth}${reach}`)
    if (!row.complete) {
      const missing = Object.entries(row.credentials)
        .filter(([, value]) => !value.ok)
        .map(([kind, value]) => `${row.label[kind]}（未找到 ${value.missing.join(' / ')}）`)
      lines.push(`- 缺少：${missing.join('；')}`)
    }
    if (row.organization) {
      const org = row.organization
      lines.push(`- 组织：${org.name ?? '（未返回）'}，版本 ${org.version ?? '?'}，区域 ${org.organizationstructure ?? '?'}`)
    }
    if (row.error) lines.push(`- 错误：${row.error}`)
  }

  if (config.issues.length) {
    lines.push('')
    lines.push('### 配置告警')
    for (const issue of config.issues) lines.push(`- ${issue}`)
  }
  if (config.configFile) lines.push('', `配置文件：${config.configFile}`)
  return lines.join('\n')
}

/**
 * Register the tool.
 * @param ctx - host context.
 * @param state - holds the raw patch config.
 * @returns disposer.
 */
export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args = {}) {
      const config = await loadConfig(state.rawConfig)
      const report = await environmentStatus(config, { check: args.check === true })
      return { text: renderReport(config, report) }
    },
    presentCall(args = {}) {
      return {
        card: 'generic',
        title: args.check ? '检查 D365 环境' : '列出 D365 环境',
        kind: 'other',
        rawInput: args,
      }
    },
  })
}
