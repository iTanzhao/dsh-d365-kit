/**
 * `d365_configure` — the agent's face of the settings page.
 *
 * Same operations, same storage code: an agent that learns a URL and a
 * credential in chat writes exactly what the form would have written.
 */
import { checkEnvironment, readSettings, saveSettings } from './settings-store.js'
import { D365Error } from './errors.js'

export const definition = {
  name: 'd365_configure',
  description:
    '查看或修改 D365 环境配置：环境 URL、租户、应用用户 ClientId、客户端密钥，以及默认环境。'
    + '与设置页里的"D365 环境"是同一份数据。注意：写入的密钥明文存到本机 d365.secrets.json，不进 d365.config.json。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'save', 'remove', 'check'],
        description: 'list 查看；save 新增或修改一个环境；remove 删除一个环境；check 真实连一次验证凭据。默认 list。',
      },
      environment: { type: 'string', description: '环境 key，例如 dev。save/remove/check 必填。' },
      url: { type: 'string', description: 'save：环境 URL，例如 https://contoso-dev.crm5.dynamics.com' },
      label: { type: 'string', description: 'save：显示名，例如 开发。' },
      cloud: {
        type: 'string',
        enum: ['public', 'usgovernment', 'dod', 'china'],
        description: 'save：云，默认 public。',
      },
      tenantId: { type: 'string', description: 'save：Entra 租户 ID。' },
      clientId: { type: 'string', description: 'save：应用用户 ClientId。' },
      clientSecret: { type: 'string', description: 'save：客户端密钥（写入 d365.secrets.json，不进 config）。' },
      clearSecret: { type: 'boolean', description: 'save：清掉已保存的密钥。' },
      defaultEnvironment: { type: 'string', description: 'save：同时把默认环境设为它。' },
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

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args = {}) {
      const action = args.action ?? 'list'
      const raw = state.rawConfig

      if (action === 'list') {
        return { text: renderSettings(await readSettings(raw)) }
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

      if (action === 'save') {
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
      }

      throw new D365Error(`未知 action：${action}`, { hint: '可用：list / save / remove / check' })
    },
    presentCall(args = {}) {
      return { card: 'generic', title: `D365 配置：${args.action ?? 'list'}`, kind: 'other', rawInput: args }
    },
  })
}
