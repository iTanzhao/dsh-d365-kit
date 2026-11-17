/**
 * `d365_envs` — the environment registry: what exists, can it be reached, and
 * the edits to that registry.
 *
 * `list` answers "what am I connected to" before any metadata question and
 * separates "not configured" from "configured but the secret is missing" from
 * "configured but unreachable". `save` / `remove` write the same storage the
 * settings page writes (0.37.0 merged the former `d365_configure` tool in here:
 * one registry, one tool).
 */
import { checkEnvironment, readSettings, saveSettings } from './settings-store.js'
import { loadConfig } from './config.js'
import { environmentStatus } from './runtime.js'
import { D365Error } from './errors.js'

const ACTIONS = ['list', 'check', 'save', 'remove']

export const definition = {
  name: 'd365_envs',
  description:
    '环境登记表：list 看有哪些环境、凭据是否齐全、能不能连通；check 真实连一次；save 新增或修改一个环境；remove 删除一个环境。'
    + '改的是本机配置（d365.config.json 与 d365.secrets.json），不需要环境权限。'
    + '在回答任何"某个环境里有没有 X"之前先 list，避免把"没配置"误说成"环境里没有"。'
    + '它只管环境登记；环境里的元数据用 d365_metadata，字段/选项值等变更用 d365_metadata_write，业务记录用 d365_data 与 d365_data_write。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'list 查看（默认）；check 连一次验证；save 新增或修改；remove 删除。',
      },
      environment: { type: 'string', description: '环境 key，例如 dev。check/save/remove 需要它；check 省略时检查全部环境。' },
      url: { type: 'string', description: 'save：站点根地址，例如 https://contoso-dev.crm5.dynamics.com（不带 /api/data）。' },
      label: { type: 'string', description: 'save：显示名，例如 开发。' },
      cloud: {
        type: 'string',
        enum: ['public', 'usgovernment', 'dod', 'china'],
        description: 'save：云，默认 public。',
      },
      tenantId: { type: 'string', description: 'save：Entra 租户 ID。' },
      clientId: { type: 'string', description: 'save：应用用户 ClientId。' },
      clientSecret: { type: 'string', description: 'save：客户端密钥，写入 d365.secrets.json（明文，勿提交），不进 config。' },
      clearSecret: { type: 'boolean', description: 'save：清掉已保存的密钥。' },
      defaultEnvironment: { type: 'string', description: 'save：同时把它设为默认环境。' },
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

/** Turn a settings view back into a save payload row. */
function rowOf(entry) {
  return {
    url: entry.url,
    label: entry.label,
    cloud: entry.cloud,
    tenantId: entry.tenantId,
    tenantIdEnv: entry.tenantIdEnv,
    clientId: entry.clientId,
    clientIdEnv: entry.clientIdEnv,
    note: entry.note,
  }
}

function renderSettings(settings) {
  const lines = []
  const envs = settings.environments ?? []
  lines.push(`已配置 ${envs.length} 个环境，默认：${settings.defaultEnvironment ?? '（无）'}`)
  lines.push(`配置文件：${settings.configFile ?? '（未配置 configFile）'}`)
  if (envs.length) {
    lines.push('')
    lines.push('| 环境 | URL | 云 | 凭据 |')
    lines.push('| --- | --- | --- | --- |')
    for (const env of envs) {
      const state = env.complete
        ? '齐全'
        : `缺 ${env.missing.map((item) => item.kind).join('/')}`
      const secret = env.hasSecret ? `密钥(${env.secretSource})` : '无密钥'
      lines.push(`| ${env.key} | ${env.url} | ${env.cloud} | ${state === '齐全' ? `齐全，${secret}` : `${state}，${secret}`} |`)
    }
  } else {
    lines.push('', '还没有环境。用 action=save 添加，或在设置页的"D365 环境"里填。')
  }
  if (settings.issues?.length) {
    lines.push('', '配置告警：')
    for (const issue of settings.issues) lines.push(`- ${issue}`)
  }
  if (settings.secretsFile) lines.push('', `密钥文件：${settings.secretsFile}`)
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
      const action = args.action ?? 'list'
      if (!ACTIONS.includes(action)) {
        throw new D365Error(`未知 action：${action}`, { hint: `可用：${ACTIONS.join(' / ')}` })
      }
      const raw = state.rawConfig

      if (action === 'list' || (action === 'check' && !String(args.environment ?? '').trim())) {
        const config = await loadConfig(raw)
        const report = await environmentStatus(config, { check: action === 'check' })
        return { text: renderReport(config, report) }
      }

      const key = String(args.environment ?? '').trim()
      if (!key) throw new D365Error(`${action} 需要 environment`, { hint: '例如 environment: "dev"' })

      if (action === 'check') {
        const result = await checkEnvironment(raw, key)
        if (result.ok) {
          const org = result.organization ?? {}
          return {
            text: `环境 ${key} 连接正常：${org.name ?? '（未返回名称）'}，版本 ${org.version ?? '?'}，区域 ${org.organizationstructure ?? '?'}\nURL：${org.url ?? ''}`,
          }
        }
        const missing = result.missing?.length
          ? `\n缺少：${result.missing.map((item) => `${item.kind}（${item.missing.join(' / ')}）`).join('；')}`
          : ''
        return { text: `环境 ${key} 连接失败：${result.error}${missing}${result.hint ? `\n建议：${result.hint}` : ''}` }
      }

      const settings = await readSettings(raw)
      const rows = {}
      for (const env of settings.environments) rows[env.key] = rowOf(env)

      if (action === 'remove') {
        if (!rows[key]) {
          throw new D365Error(`没有名为 ${key} 的环境`, {
            hint: `现有：${Object.keys(rows).join(', ') || '（无）'}`,
          })
        }
        delete rows[key]
        const result = await saveSettings(raw, {
          defaultEnvironment: settings.defaultEnvironment,
          environments: rows,
        })
        return { text: `已删除环境 ${key}。\n\n${renderSettings(result.settings)}` }
      }

      const previous = rows[key] ?? {}
      const merged = {
        ...previous,
        url: args.url ?? previous.url,
        label: args.label ?? previous.label,
        cloud: args.cloud ?? previous.cloud,
        tenantId: args.tenantId ?? previous.tenantId,
        clientId: args.clientId ?? previous.clientId,
      }
      if (args.clientSecret) merged.clientSecret = args.clientSecret
      if (args.clearSecret) merged.clearSecret = true
      rows[key] = merged

      const result = await saveSettings(raw, {
        defaultEnvironment: args.defaultEnvironment ?? settings.defaultEnvironment ?? key,
        environments: rows,
      })
      const touched = result.secretsTouched.includes(key)
        ? '\n密钥已写入本机 d365.secrets.json（明文，勿提交到 Git）。'
        : ''
      return { text: `已保存环境 ${key}。${touched}\n\n${renderSettings(result.settings)}` }
    },
    presentCall(args = {}) {
      const action = args.action ?? 'list'
      return {
        card: 'generic',
        title: `D365 环境：${action}`,
        kind: 'other',
        rawInput: args,
      }
    },
  })
}
