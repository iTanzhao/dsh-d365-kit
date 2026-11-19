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
import { t } from './i18n.js'

const ACTIONS = ['list', 'check', 'save', 'remove']

export const definition = {
  name: 'd365_envs',
  description:
    'Environment registry: list configured environments and credential/connectivity status; check connectivity; save or remove a local environment. '
    + 'This edits local d365.config.json and d365.secrets.json and does not require an environment permission. '
    + 'Run list before answering whether an environment contains X. Use d365_metadata for environment metadata, d365_metadata_write for definition changes, and d365_data/d365_data_write for records.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'list (default), check connectivity, save/create-update, or remove.',
      },
      environment: { type: 'string', description: 'Environment key such as dev. Required for save/remove; omitted check queries all environments.' },
      url: { type: 'string', description: 'For save: site root such as https://contoso-dev.crm5.dynamics.com, without /api/data.' },
      label: { type: 'string', description: 'For save: display label such as Development.' },
      cloud: {
        type: 'string',
        enum: ['public', 'usgovernment', 'dod', 'china'],
        description: 'For save: cloud, default public.',
      },
      tenantId: { type: 'string', description: 'For save: Entra tenant ID.' },
      clientId: { type: 'string', description: 'For save: application-user ClientId.' },
      clientSecret: { type: 'string', description: 'For save: client secret stored in d365.secrets.json as plaintext, never in config.' },
      clearSecret: { type: 'boolean', description: 'For save: clear the stored secret.' },
      defaultEnvironment: { type: 'string', description: 'For save: also make this the default environment.' },
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
  lines.push(t('env.report.heading', { count: report.length, default: config.defaultEnvironment ?? t('common.none') }))

  for (const row of report) {
    const { env } = row
    const tag = env.key === config.defaultEnvironment ? ` ${t('common.default')}` : ''
    const auth = row.complete ? t('env.credentials.complete') : t('env.credentials.incomplete')
    const reach = row.reachable === undefined ? '' : row.reachable ? `, ${t('env.reachable')}` : `, ${t('env.unreachable')}`
    lines.push('')
    lines.push(`### ${env.key}${tag}${env.label && env.label !== env.key ? ` — ${env.label}` : ''}`)
    lines.push(`- ${t('env.url', { value: env.url })}`)
    lines.push(`- ${t('env.cloud', { value: env.cloud, note: env.note ? t('env.note', { value: env.note }) : '' })}`)
    lines.push(`- ${t('env.status', { value: `${auth}${reach}` })}`)
    if (!row.complete) {
      const missing = Object.entries(row.credentials)
        .filter(([, value]) => !value.ok)
        .map(([kind, value]) => `${row.label[kind]} (${t('env.check.missing', { value: value.missing.join(' / ') })})`)
      lines.push(`- ${t('env.missing', { value: missing.join('; ') })}`)
    }
    if (row.organization) {
      const org = row.organization
      lines.push(`- ${t('env.organization', { name: org.name ?? t('common.none'), version: org.version ?? '?', region: org.organizationstructure ?? '?' })}`)
    }
    if (row.error) lines.push(`- ${t('env.error', { value: row.error })}`)
  }

  if (config.issues.length) {
    lines.push('')
    lines.push(`### ${t('env.warnings')}`)
    for (const issue of config.issues) lines.push(`- ${issue}`)
  }
  if (config.configFile) lines.push('', t('env.configFile', { value: config.configFile }))
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
  lines.push(t('env.settings.heading', { count: envs.length, default: settings.defaultEnvironment ?? t('common.none') }))
  lines.push(t('env.configFile', { value: settings.configFile ?? t('common.none') }))
  if (envs.length) {
    lines.push('')
    lines.push(t('env.table.header'))
    lines.push('| --- | --- | --- | --- |')
    for (const env of envs) {
      const state = env.complete
        ? t('env.credentials.complete')
        : t('env.missing', { value: env.missing.map((item) => item.kind).join('/') })
      const secret = env.hasSecret ? `secret (${env.secretSource})` : 'no secret'
      lines.push(`| ${env.key} | ${env.url} | ${env.cloud} | ${state}; ${secret} |`)
    }
  } else {
    lines.push('', t('env.noEnvironments'))
  }
  if (settings.issues?.length) {
    lines.push('', t('env.settings.warnings'))
    for (const issue of settings.issues) lines.push(`- ${issue}`)
  }
  if (settings.secretsFile) lines.push('', t('env.secretsFile', { value: settings.secretsFile }))
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
        throw new D365Error(t('env.unknownAction', { action }), { hint: t('env.availableActions', { values: ACTIONS.join(' / ') }) })
      }
      const raw = state.rawConfig

      if (action === 'list' || (action === 'check' && !String(args.environment ?? '').trim())) {
        const config = await loadConfig(raw)
        const report = await environmentStatus(config, { check: action === 'check' })
        return { text: renderReport(config, report) }
      }

      const key = String(args.environment ?? '').trim()
      if (!key) throw new D365Error(t('env.environmentRequired', { action }), { hint: t('env.environmentExample') })

      if (action === 'check') {
        const result = await checkEnvironment(raw, key)
        if (result.ok) {
          const org = result.organization ?? {}
          return {
            text: `${t('env.check.ok', { key, name: org.name ?? t('common.none'), version: org.version ?? '?', region: org.organizationstructure ?? '?' })}\n${t('env.url', { value: org.url ?? '' })}`,
          }
        }
        const missing = result.missing?.length
          ? `\n${t('env.check.missing', { value: result.missing.map((item) => `${item.kind} (${item.missing.join(' / ')})`).join('; ') })}`
          : ''
        return { text: `${t('env.check.failed', { key, error: result.error })}${missing}${result.hint ? `\n${t('env.check.hint', { value: result.hint })}` : ''}` }
      }

      const settings = await readSettings(raw)
      const rows = {}
      for (const env of settings.environments) rows[env.key] = rowOf(env)

      if (action === 'remove') {
        if (!rows[key]) {
          throw new D365Error(t('env.notFound', { key }), {
            hint: t('env.existing', { values: Object.keys(rows).join(', ') || t('common.none') }),
          })
        }
        delete rows[key]
        const result = await saveSettings(raw, {
          defaultEnvironment: settings.defaultEnvironment,
          environments: rows,
        })
        return { text: `${t('env.removed', { key })}\n\n${renderSettings(result.settings)}` }
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
        ? `\n${t('env.secretTouched')}`
        : ''
      return { text: `${t('env.saved', { key })}${touched}\n\n${renderSettings(result.settings)}` }
    },
    presentCall(args = {}) {
      const action = args.action ?? 'list'
      return {
        card: 'generic',
        title: t('env.title', { action }),
        kind: 'other',
        rawInput: args,
      }
    },
  })
}
