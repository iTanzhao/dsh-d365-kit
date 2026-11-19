/**
 * Write business records — create one row, or patch fields on one row.
 *
 * Deliberately narrow: no delete, no bulk update, no upsert by filter. Every
 * call is confirmed in the conversation first, because business data is not
 * something a plan file can stage ahead of time the way metadata can.
 */
import { randomUUID } from 'node:crypto'
import { loadConfig } from './config.js'
import { D365Error } from './errors.js'
import { allows, readPolicy } from './write-policy.js'
import { makeClient, pickEnvironments, writeArtifact } from './runtime.js'
import { resolveEntitySet, recordKey } from './tool-data.js'
import { t } from './i18n.js'

const APPROVE = () => t('dataWrite.approve')
const CANCEL = () => t('dataWrite.cancel')
const CONFIRM_ID = 'd365-data-write-confirm'

const ACTIONS = ['create', 'update']

const definition = {
  name: 'd365_data_write',
  description: 'Create or update one business record (never delete). Requires data.write permission and always asks for confirmation. Use d365_data_sync plan-update for bulk changes and d365_metadata_write for metadata.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'entity', 'values'],
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'create adds one record; update changes an existing record by id.',
      },
      entity: {
        type: 'string',
        description: 'Entity logical name or collection name, such as contoso_systemconfiguration.',
      },
      id: {
        type: 'string',
        description: 'Required for update: primary-key GUID or an alternate-key literal such as contoso_code=\'001\'.',
      },
      values: {
        type: 'object',
        additionalProperties: true,
        description: 'Fields and values to write using logical names; null clears a value.',
      },
      environment: {
        type: 'string',
        description: 'Environment key; the configured default is used when omitted.',
      },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string', description: 'Human-readable summary.' } },
    },
    render(_args, value) {
      return [{ type: 'text', text: value.text }]
    },
  },
}

function clip(value, max = 120) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === undefined) return 'null'
  return text.length > max ? `${text.slice(0, max)}… (${t('dataWrite.characters', { count: text.length })})` : text
}

function describeValues(values) {
  const entries = Object.entries(values ?? {})
  if (!entries.length) return t('dataWrite.noFields')
  const lines = entries.slice(0, 20).map(([key, value]) => `  ${key} = ${clip(value)}`)
  if (entries.length > 20) lines.push(`  … ${t('dataWrite.moreFields', { count: entries.length - 20 })}`)
  return lines.join('\n')
}

function describeConfirmation(envKey, set, action, id, values) {
  const lines = [t('dataWrite.environment', { env: envKey }), t('dataWrite.target', { set }), t('dataWrite.operation', { operation: action === 'create' ? t('dataWrite.createOne') : t('dataWrite.updateOne', { id }) })]
  lines.push(t('dataWrite.fields'))
  lines.push(describeValues(values))
  lines.push(t('dataWrite.immediateNote'))
  return lines.join('\n')
}

function checkValues(values) {
  const entries = Object.entries(values ?? {})
  if (!entries.length) throw new D365Error(t('dataWrite.valuesRequired'), { hint: t('dataWrite.valuesHint') })
  for (const [key] of entries) {
    if (key.startsWith('@')) {
      throw new D365Error(t('dataWrite.annotation', { key }), { code: 'invalid-field' })
    }
  }
  return entries.length
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args, exec) {
      const action = String(args.action ?? '')
      if (!ACTIONS.includes(action)) {
        throw new D365Error(t('dataWrite.badAction', { action }), { hint: t('dataWrite.allowed', { values: ACTIONS.join(' / ') }) })
      }
      const config = await loadConfig(state.rawConfig)
      const targets = pickEnvironments(config, {
        environment: args.environment,
        environments: args.environments,
        allEnvironments: args.allEnvironments,
      })
      if (targets.length !== 1) {
        throw new D365Error(t('dataWrite.oneEnvironment'), {
          hint: t('dataWrite.oneEnvironmentHint', { count: targets.length, values: targets.map((item) => item.key).join(', ') }),
        })
      }
      const env = targets[0]
      const envKey = env.key

      const policy = await readPolicy(config.configFile)
      if (!allows(policy, envKey, 'data.write')) {
        throw new D365Error(t('dataWrite.forbidden', { env: envKey }), {
          code: 'data-write-forbidden',
          hint: t('dataWrite.forbiddenHint', { env: envKey }),
        })
      }

      const values = args.values && typeof args.values === 'object' ? args.values : {}
      const fieldCount = checkValues(values)
      const client = makeClient(env, config)
      const resolved = await resolveEntitySet(client, args.entity, exec?.signal)
      const rawId = String(args.id ?? '').trim()
      if (action === 'update' && !rawId) {
        throw new D365Error(t('dataWrite.updateId'), { hint: t('dataWrite.updateIdHint') })
      }
      // The id becomes a path segment (`set(id)`), so it is validated rather
      // than trusted: `/`, `?`, `&` or `..` would address a different set.
      const id = action === 'update' ? recordKey(rawId) : ''

      const userQuestions = ctx.get('userQuestions')
      if (!userQuestions?.ask) {
        throw new D365Error(t('dataWrite.noConfirmation'), {
          hint: t('dataWrite.confirmRequired'),
        })
      }
      if (!exec?.agent) {
        throw new D365Error(t('dataWrite.interactiveRequired'), { hint: t('dataWrite.interactiveHint') })
      }

      const answer = await userQuestions.ask({
        questions: [{
          id: CONFIRM_ID,
          header: t('dataWrite.confirmHeader', { env: envKey }),
          question: action === 'create'
            ? t('dataWrite.confirmCreate', { env: envKey, set: resolved.set })
            : t('dataWrite.confirmUpdate', { env: envKey, set: resolved.set, id }),
          detail: describeConfirmation(envKey, resolved.set, action, id, values),
          options: [
            { label: APPROVE(), description: t('dataWrite.approveHint') },
            { label: CANCEL(), description: t('dataWrite.cancelHint') },
          ],
        }],
        agent: exec.agent,
        ...(exec.signal ? { signal: exec.signal } : {}),
        wait: { callId: exec.callId },
      })
      const chosen = answer?.answers?.find((item) => item.id === CONFIRM_ID)?.selected?.[0]
      if (chosen !== APPROVE()) return { text: t('dataWrite.canceled', { env: envKey, set: resolved.set }) }

      let createdId
      if (action === 'create') {
        const record = await client.sendJson(resolved.set, {
          method: 'POST',
          body: values,
          headers: { Prefer: 'return=representation' },
        }, exec.signal)
        const entry = Object.entries(record ?? {})
          .find(([key, value]) => typeof value === 'string' && (key === resolved.idField || /^\w*id$/i.test(key)))
        createdId = entry?.[1]
      } else {
        await client.sendJson(`${resolved.set}(${id})`, {
          method: 'PATCH',
          body: values,
          headers: { 'If-Match': '*' },
        }, exec.signal)
      }

      const artifact = {
        kind: 'data-write',
        at: new Date().toISOString(),
        envKey,
        entitySet: resolved.set,
        action,
        id: createdId ?? (action === 'update' ? id : undefined),
        fields: Object.keys(values),
      }
      const path = await writeArtifact(config, `data-write-${randomUUID().slice(0, 8)}`, artifact)
      const target = action === 'create'
        ? t('dataWrite.created', { env: envKey, set: resolved.set, id: createdId ? ` (id ${createdId})` : '', count: fieldCount })
        : t('dataWrite.updated', { env: envKey, set: resolved.set, id, count: fieldCount })
      return { text: `${target}\n\n${t('dataWrite.audit', { path })}` }
    },
  })
}
