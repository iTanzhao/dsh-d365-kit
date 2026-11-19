/**
 * `d365_refs` — the reverse question: who uses this?
 *
 * `d365_metadata` answers "does it exist"; `d365_layers` answers "who overrides
 * it"; this answers "what breaks if I remove or rename it". Every branch reads
 * stored definitions (formxml, layoutxml/fetchxml, workflow clientdata) and
 * reports exact matches, so the answer is evidence rather than a guess.
 */
import { loadConfig } from './config.js'
import { makeClient, mapEnvironments, pickEnvironments, writeArtifact } from './runtime.js'
import { D365Error } from './errors.js'
import { t } from './i18n.js'
import {
  findFieldAutomations,
  findFieldForms,
  findFieldViews,
  findPluginUsage,
  findResourceForms,
} from './refs.js'

const KINDS = ['field', 'web_resource', 'plugin_assembly']

export const definition = {
  name: 'd365_refs',
  description:
    'Find references: discover which forms, views, flows, or plug-in registrations use a field, Web resource, or plug-in assembly.'
    + 'Supports multiple environments and helps assess whether changing or deleting a component will break something.'
    + 'Use d365_layers to inspect overrides.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['kind'],
    properties: {
      kind: {
        type: 'string',
        enum: KINDS,
        description: 'field: column references; web_resource: form-script references; plugin_assembly: plug-in registrations.',
      },
      entity: {
        type: 'string',
        description: 'Required for field: owning table logical name, such as account.',
      },
      attribute: {
        type: 'string',
        description: 'Required for field: column logical name, such as contoso_customertier.',
      },
      name: {
        type: 'string',
        description: 'For web_resource: web-resource name; for plugin_assembly: assembly name.',
      },
      environment: {
        type: 'string',
        description: 'Environment key such as dev; uses the configured default when omitted.',
      },
      environments: {
        type: 'array',
        items: { type: 'string' },
        description: 'Query multiple environments, such as ["dev","sit"].',
      },
      allEnvironments: {
        type: 'boolean',
        description: 'Run the same query in every configured environment.',
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

/** Render a field reference report for one environment. */
function renderField(env, entity, attribute, result) {
  const lines = [t('refs.fieldHeading', { entity, attribute, environment: env.key })]
  const total = result.forms.length + result.views.length + result.automations.length

  lines.push('', t('refs.forms', { count: result.forms.length }))
  for (const form of result.forms.slice(0, 10)) {
    lines.push(`- ${form.name}（${form.typeLabel}${form.managed ? t('refs.managed') : ''}${form.visible ? '' : t('refs.hidden')}）`)
  }
  if (result.forms.length > 10) lines.push(t('refs.more', { count: result.forms.length - 10 }))

  const layout = result.views.filter((view) => view.inLayout).length
  const filtered = result.views.filter((view) => view.inFilter).length
  lines.push('', t('refs.views', { count: result.views.length, layout, filtered }))
  for (const view of result.views.slice(0, 10)) {
    const usage = [view.inLayout ? t('refs.displayColumn') : null, view.inFilter ? t('refs.filterCondition') : null].filter(Boolean).join('+')
    lines.push(`- ${view.name}（${usage}${view.default ? t('refs.defaultView') : ''}）`)
  }
  if (result.views.length > 10) lines.push(t('refs.more', { count: result.views.length - 10 }))

  lines.push('', t('refs.automations', { count: result.automations.length }))
  for (const item of result.automations.slice(0, 10)) {
    lines.push(`- ${item.name}（${item.category}，${item.state}）`)
  }
  if (result.automations.length > 10) lines.push(t('refs.more', { count: result.automations.length - 10 }))

  lines.push(
    '',
    total
      ? t('refs.fieldConclusion', { count: total })
      : t('refs.fieldNone'),
  )
  return lines.join('\n')
}

/** Render a web resource report for one environment. */
function renderResource(env, name, forms) {
  const lines = [t('refs.resourceHeading', { name, environment: env.key })]
  if (!forms.length) {
    lines.push('', t('refs.resourceNone'))
    return lines.join('\n')
  }
  lines.push('', t('refs.forms', { count: forms.length }))
  let handlers = 0
  for (const form of forms.slice(0, 12)) {
    handlers += form.handlers.length
    const names = form.handlers.map((h) => `${h.event || '?'}→${h.functionName || '?'}`).join(', ')
    lines.push(`- ${form.name}（${form.typeLabel}，${form.entity}）${names ? `: ${names}` : ''}`)
  }
  if (forms.length > 12) lines.push(t('refs.more', { count: forms.length - 12 }))
  lines.push('', t('refs.resourceConclusion', { forms: forms.length, handlers }))
  return lines.join('\n')
}

/** Render a plugin assembly report for one environment. */
function renderAssembly(env, name, result) {
  const { assembly, types } = result
  const lines = [
    t('refs.assemblyHeading', { name: assembly.name, environment: env.key }),
    t('refs.assemblyMeta', { version: assembly.version ?? t('refs.unknown'), isolation: assembly.isolation ?? '?' }),
    t('refs.types', { count: types.length }),
  ]
  // Count every type: the digest only prints the first twelve, but the total step count
  // must be the real N — an undercount reads as "there are fewer steps than
  // there are", which is exactly what someone checking a missing registration
  // will believe.
  const stepCount = types.reduce((sum, type) => sum + type.steps.length, 0)
  const disabled = types.reduce((sum, type) => sum + type.steps.filter((step) => !step.enabled).length, 0)
  for (const type of types.slice(0, 12)) {
    lines.push('', `- ${type.typename}`)
    if (!type.steps.length) lines.push(t('refs.noSteps'))
    for (const step of type.steps.slice(0, 8)) {
      const filter = step.filteringAttributes ? t('refs.stepFilter', { value: step.filteringAttributes }) : ''
      lines.push(t('refs.step', { name: step.name, stage: step.stage, mode: step.mode, rank: step.rank ?? 1, filter, disabled: step.enabled ? '' : t('refs.disabled') }))
    }
    if (type.steps.length > 8) lines.push(t('refs.moreSteps', { count: type.steps.length - 8 }))
  }
  if (types.length > 12) lines.push(t('refs.moreTypes', { count: types.length - 12 }))
  lines.push('', t('refs.assemblyConclusion', { steps: stepCount, disabled: disabled ? t('refs.disabledCount', { count: disabled }) : '' }))
  return lines.join('\n')
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args, exec) {
      const config = await loadConfig(state.rawConfig)
      const kind = args.kind
      if (!KINDS.includes(kind)) {
        throw new D365Error(`Unknown query kind: ${kind}`, { code: 'unknown-kind', i18nParams: { kind }, i18nKey: 'refs.unknownKind', hintKey: 'refs.allowed', hintParams: { values: KINDS.join(' / ') } })
      }
      if (kind === 'field' && (!args.entity || !args.attribute)) {
        throw new D365Error('kind=field requires entity and attribute', { code: 'missing-field', i18nKey: 'refs.fieldRequired' })
      }
      if (kind !== 'field' && !args.name) {
        throw new D365Error(`kind=${kind} requires name`, { code: 'missing-name', i18nParams: { kind }, i18nKey: 'refs.nameRequired' })
      }

      const envs = pickEnvironments(config, args)
      // Slot per environment: workers finish in any order, the report must not.
      const sections = new Array(envs.length)
      const artifact = { kind, entity: args.entity, attribute: args.attribute, name: args.name, environments: {} }

      await mapEnvironments(envs, async (env, index) => {
        try {
        const client = makeClient(env, config)
        let text
        if (kind === 'field') {
          const result = {
            forms: await findFieldForms(client, args.entity, args.attribute, exec?.signal),
            views: await findFieldViews(client, args.entity, args.attribute, exec?.signal),
            automations: await findFieldAutomations(client, args.entity, args.attribute, exec?.signal),
          }
          artifact.environments[env.key] = result
          text = renderField(env, args.entity, args.attribute, result)
        } else if (kind === 'web_resource') {
          const forms = await findResourceForms(client, args.name, exec?.signal)
          artifact.environments[env.key] = { forms }
          text = renderResource(env, args.name, forms)
        } else {
          const result = await findPluginUsage(client, args.name, exec?.signal)
          artifact.environments[env.key] = result
          text = renderAssembly(env, args.name, result)
        }
        sections[index] = text
        } catch (error) {
          // One environment failing must not erase the others.
          sections[index] = [
            t('refs.queryFailed', { environment: env.key }),
            `- ${error?.message ?? String(error)}`,
            error?.hint ? `- ${t('refs.hint')}: ${error.hint}` : '',
          ].filter(Boolean).join('\n')
        }
      })

      const file = await writeArtifact(config, `refs-${kind}`, artifact)
      return { text: `${sections.filter(Boolean).join('\n\n')}\n\n${t('refs.fullResult', { file })}` }
    },
  })
}
