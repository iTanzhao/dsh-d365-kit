/**
 * `d365_metadata_write` — the agent's write surface.
 *
 * Planning is free; executing needs a person. `execute` opens a question card in
 * the conversation and waits for the answer, so the human approval happens in
 * the chat itself. The settings page stays available for the same confirm step.
 */
import { DataverseClient } from './client.js'
import { loadConfig } from './config.js'
import { D365Error } from './errors.js'
import { busyError, checkEnvironmentIdle } from './preflight.js'
import { CAPABILITIES, allows, describePolicy, readPolicy } from './write-policy.js'
import { deletePlan, listPlans } from './write-store.js'
import { t } from './i18n.js'
import {
  executePlan,
  planAddAttribute,
  planOptionAdd,
  planOptionDelete,
  planOptionRelabel,
  planRemoveLayer,
  planDeleteAttribute,
  planUpdateAttribute,
  planUpdateEntity,
  planViewColumns,
  savePlan,
} from './write-actions.js'

const APPROVE = () => t('write.approve')
const CANCEL = () => t('write.cancel')
const CONFIRM_ID = 'd365-write-confirm'

const ACTIONS = [
  'policy',
  'plan-add-options',
  'plan-relabel',
  'plan-option-delete',
  'plan-add-attribute',
  'plan-update-attribute',
  'plan-delete-attribute',
  'plan-remove-layer',
  'plan-update-entity',
  'plan-view-columns',
  'list',
  'execute',
  'cancel',
]

export const definition = {
  name: 'd365_metadata_write',
  description:
    'Prepare and execute Dataverse metadata changes: option values, columns, table names, system-view columns, and removal of the top custom component layer. '
    + 'plan-* actions only create a plan; execute requires human approval and the configured environment capability. '
    + 'Use d365_data_write or d365_data_sync for records, and d365_roles for security roles.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description:
          'policy inspects permissions; plan-add-options/plan-relabel/plan-option-delete handle option sets; plan-add-attribute/plan-update-attribute/plan-delete-attribute handle columns; '
          + 'plan-update-entity handles tables; plan-view-columns handles views; plan-remove-layer handles layers; list/show/cancel/execute manage plans. '
          + 'Deleting option values or columns and removing layers requires acknowledge=true and is irreversible. Defaults to policy.',
      },
      environment: { type: 'string', description: 'Target environment key such as dev.' },
      optionSet: { type: 'string', description: 'Global option-set name, such as contoso_taxcategoryos. For a field-local set, use entity + attribute.' },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'For plan-add-options: each item is "AD3|Andorra: Tax Register Number (NRT)"; existing numeric values are skipped.',
      },
      updates: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            value: { type: 'integer', description: 'Existing option value.' },
            label: { type: 'string', description: 'New label.' },
          },
        },
        description: 'For plan-relabel: options whose labels are changed.',
      },
      values: {
        type: 'array',
        items: { type: 'integer' },
        description: 'For plan-option-delete: option values to delete.',
      },
      view: {
        type: 'string',
        description: 'For plan-view-columns: system-view name, such as "Active Accounts".',
      },
      addColumns: {
        type: 'array',
        items: { type: 'string' },
        description: 'For plan-view-columns: logical column names to add.',
      },
      removeColumns: {
        type: 'array',
        items: { type: 'string' },
        description: 'For plan-view-columns: logical column names to remove.',
      },
      entity: {
        type: 'string',
        description: 'Table logical name, such as account; required for column, table, and local-option-set operations.',
      },
      attribute: {
        type: 'string',
        description: 'Column logical name for plan-update-attribute/plan-delete-attribute; with entity it can also target a local option set.',
      },
      fieldType: {
        type: 'string',
        enum: ['string', 'memo', 'integer', 'decimal', 'money', 'boolean', 'datetime'],
        description: 'For plan-add-attribute: field type, default string.',
      },
      schemaName: {
        type: 'string',
        description: 'For plan-add-attribute: SchemaName with a publisher prefix, such as new_TestField.',
      },
      displayName: {
        type: 'string',
        description: 'Display name. For new columns it defaults to schemaName; updates change only supplied values.',
      },
      description: { type: 'string', description: 'Optional description.' },
      maxLength: { type: 'integer', description: 'Maximum length for string/memo, default 100/2000.' },
      precision: { type: 'integer', description: 'Decimal places for decimal/money, default 2.' },
      requiredLevel: {
        type: 'string',
        enum: ['None', 'Recommended', 'Required'],
        description: 'Required level, default None.',
      },
      language: {
        type: 'integer',
        description: 'Label language code, default 1033; Simplified Chinese uses 2052.',
      },
      acknowledge: {
        type: 'boolean',
        description: 'plan-delete-attribute and plan-remove-layer require true explicitly; these operations are irreversible.',
      },
      componentType: {
        type: 'string',
        enum: [
          'Entity',
          'Attribute',
          'OptionSet',
          'SavedQuery',
          'Workflow',
          'SystemForm',
          'WebResource',
          'PluginType',
          'PluginAssembly',
          'SdkMessageProcessingStep',
          'CustomAPI',
        ],
        description: 'For plan-remove-layer: component type, default Entity; same enum as d365_layers.',
      },
      component: {
        type: 'string',
        description: 'For plan-remove-layer: component name or GUID; use a table logical name for Entity, a column logical name plus entity for Attribute, or a record name/unique name otherwise.',
      },
      solutionUniqueName: {
        type: 'string',
        description: 'Unique name of the unmanaged solution carrying the change, required for solution export.',
      },
      rationale: { type: 'string', description: 'Reason for the change, recorded in the plan and change ledger.' },
      planId: { type: 'string', description: 'For execute/cancel: target plan id.' },
      force: {
        type: 'boolean',
        description: 'For execute: skip the "publishing/importing" preflight. Use only after verifying the publish record is stale.',
      },
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

function renderPolicy(policy, envKeys) {
  const { rows } = describePolicy(policy, envKeys)
  const lines = [t('write.policyTitle'), '']
  lines.push(t('write.policyHeader'))
  lines.push('| --- | --- |')
  for (const row of rows) {
    const grants = row.capabilities.length
      ? row.capabilities.map((key) => `${CAPABILITIES[key].label}（${key}）`).join('；')
      : t('write.readOnly')
    lines.push(`| ${row.environment} | ${grants} |`)
  }
  lines.push('')
  lines.push(t('write.capabilities'))
  let group
  for (const [key, value] of Object.entries(CAPABILITIES)) {
    if (value.group !== group) {
      group = value.group
      lines.push(`- ${group}`)
    }
    lines.push(`  - ${key}：${value.label} — ${value.description}${value.risk === 'high' ? t('write.highRisk') : ''}`)
  }
  if (policy.solutionHint) lines.push(t('write.defaultSolution', { solution: policy.solutionHint }))
  return lines.join('\n')
}

const VERBS = {
  InsertOptionValue: '+',
  CreateAttribute: '+',
  UpdateOptionValue: '~',
  UpdateAttribute: '~',
  UpdateEntity: '~',
  UpdateViewLayout: '~',
  DeleteOptionValue: '!',
  DeleteAttribute: '!',
  RemoveActiveCustomizations: '−',
}

const DESTRUCTIVE = new Set(['DeleteOptionValue', 'DeleteAttribute', 'RemoveActiveCustomizations'])

/** Where the plan writes: a global option set, a column's local one, or a table. */
function planScope(plan) {
  if (plan.optionSetName) return t('write.optionSet', { name: plan.optionSetName })
  if (plan.entity && plan.attribute) return t('write.localOptionSet', { name: `${plan.entity}.${plan.attribute}` })
  if (plan.target) return t('write.target', { target: plan.target })
  return null
}

/**
 * A layer removal is only understandable next to the stack it sits in: which
 * layer goes, and what becomes active below it.
 */
function renderLayerStack(plan) {
  const layers = plan.before?.layers
  if (!Array.isArray(layers) || !layers.length) return null
  const lines = [t('write.layerStack')]
  for (const layer of layers) {
    const name = /^active$/i.test(String(layer.solution ?? ''))
      ? 'Active (unmanaged)'
      : (layer.solution || '(system layer)')
    lines.push(`- ${layer.order}：${name}${layer.publisher ? `（${layer.publisher}）` : ''}`)
  }
  lines.push(t('write.afterRemoval', { active: plan.before?.becomesActive ?? t('write.systemDefinition') }))
  return lines.join('\n')
}

function renderOperation(operation) {
  const verb = VERBS[operation.type] ?? '·'
  // Labels come from the caller and from the target organization. Collapsing
  // them to one line keeps a label from faking extra operations in the card.
  const text = String(operation.summary ?? `${operation.type} ${operation.value ?? ''}`.trim())
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
  return `${verb} ${text}`.trim()
}

function renderSkips(plan) {
  const lines = []
  for (const skip of plan.skipped ?? []) {
    if (skip.code !== undefined) lines.push(t('write.skipExisting', { code: skip.code, value: skip.value }))
    else lines.push(t('write.skipReason', { name: skip.schemaName ?? skip.attribute ?? skip.entity ?? skip.value ?? '', reason: skip.reason ?? '' }))
  }
  return lines
}

function renderPlan(plan) {
  const lines = [t('write.planCreated', { id: plan.id })]
  lines.push(t('write.environment', { key: plan.envKey, url: plan.envUrl }))
  const scope = planScope(plan)
  if (scope) lines.push(scope)
  const stack = renderLayerStack(plan)
  if (stack) lines.push('', stack)
  lines.push(t('write.operations', { count: plan.operations.length, skipped: plan.skipped?.length ? t('write.skippedCount', { count: plan.skipped.length }) : '' }))
  lines.push('')

  for (const operation of plan.operations) lines.push(renderOperation(operation))
  lines.push(...renderSkips(plan))
  lines.push('')
  lines.push(t('write.nothingWritten'))
  return lines.join('\n')
}

/**
 * The text of the in-chat confirmation card. This is the only place a person
 * sees exactly what will be written before approving, so it lists operations
 * rather than a count.
 */
function describeForConfirmation(plan) {
  const lines = [t('write.environment', { key: plan.envKey, url: plan.envUrl })]
  const scope = planScope(plan)
  if (scope) lines.push(scope)
  lines.push(t('write.operationCount', { count: plan.operations.length }))
  for (const operation of plan.operations.slice(0, 10)) lines.push(renderOperation(operation))
  if (plan.operations.length > 10) lines.push(t('write.moreOperations', { count: plan.operations.length - 10 }))
  if (plan.operations.some((operation) => DESTRUCTIVE.has(operation.type))) {
    lines.push('', t('write.irreversibleWarning'))
  }
  lines.push('', t('write.approvalWarning'))
  return lines.join('\n')
}

function renderExecuted(plan, result) {
  const lines = [t('write.executed', { id: plan.id, succeeded: result.results.length, failed: result.failures.length })]
  if (result.failures.length) {
    lines.push('')
    for (const failure of result.failures) {
      lines.push(`! ${failure.operation?.summary ?? failure.operation?.type ?? t('write.operation')}：${failure.error}`)
    }
  }
  if (result.publishState === 'running') {
    const scope = result.publishScope ?? { entities: [], optionSets: [] }
    const targets = [
      ...scope.entities,
      ...scope.optionSets.map((name) => t('write.optionSetShort', { name })),
    ]
    lines.push('', targets.length
      ? `Publishing in the background: ${targets.join(', ')}。`
      : 'All components are publishing in the background and will take effect later.')
  } else {
    lines.push('', t('write.noPublish'))
  }
  if (result.preflight?.forced) lines.push(t('write.forcedWarning'))
  else if (result.preflight?.stale) {
    lines.push(t('write.staleExecuted', { count: result.preflight.stale }))
  }
  if (result.ledger) lines.push(t('write.ledger', { file: result.ledger }))
  return lines.join('\n')
}

/** Shared tail for every planner: save and render, or explain the no-op. */
async function finishPlan(config, plan, emptyText) {
  if (!plan.operations.length) return { text: emptyText }
  const saved = await savePlan(config, plan)
  return { text: renderPlan(saved) }
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args = {}, exec) {
      const config = await loadConfig(state.rawConfig)
      const action = args.action ?? 'policy'
      const policy = await readPolicy(config.configFile)

      if (action === 'policy') {
        return { text: renderPolicy(policy, Object.keys(config.environments)) }
      }

      if (action === 'list') {
        const plans = await listPlans(config)
        if (!plans.length) return { text: t('write.noPlans') }
        const pending = plans.filter((plan) => (plan.status ?? 'pending') === 'pending')
        const lines = [t('write.pending', { count: pending.length, extra: plans.length > pending.length ? t('write.pendingExtra', { count: plans.length - pending.length }) : '' }), '']
        for (const plan of plans) {
          const state = (plan.status ?? 'pending') === 'pending'
            ? ''
            : plan.status === 'running' ? t('write.interrupted') : plan.status === 'failed' ? t('write.failed') : t('write.executedState')
          lines.push(`- ${plan.id}(${plan.envKey}, ${CAPABILITIES[plan.capability]?.label ?? plan.kind}, ${plan.operations.length} operations)${plan.title ?? ''}${state}`)
        }
        lines.push('', t('write.executeHint'))
        return { text: lines.join('\n') }
      }

      if (action === 'cancel') {
        const id = String(args.planId ?? '').trim()
        if (!id) throw new D365Error('cancel requires planId', { code: 'missing-plan', i18nKey: 'write.cancelRequires' })
        const removed = await deletePlan(config, id)
        return { text: removed ? t('write.cancelled', { id }) : t('write.planMissingText', { id }) }
      }

      if (action === 'execute') {
        const id = String(args.planId ?? '').trim()
        if (!id) throw new D365Error('execute requires planId', { code: 'missing-plan', i18nKey: 'write.executeRequires', hintKey: 'write.executeHintKey' })
        const plan = (await listPlans(config)).find((item) => item.id === id)
        if (!plan) throw new D365Error(`Plan not found: ${id}`, { i18nKey: 'write.planMissing', i18nParams: { id }, hintKey: 'write.planMissingHint' })
        if (plan.status !== 'pending') {
          const label = plan.status === 'running'
            ? 'is running, or the previous execution was interrupted'
            : plan.status === 'failed' ? 'previous execution failed' : 'has already executed'
          throw new D365Error(`Plan ${plan.id} ${label}`, {
            code: 'plan-not-pending',
            hintKey: 'write.planNotPendingHint',
          })
        }
        if (!allows(policy, plan.envKey, plan.capability)) {
          throw new D365Error(`Environment ${plan.envKey} does not allow ${plan.capability}`, { i18nKey: 'write.capabilityDenied', i18nParams: { environment: plan.envKey, capability: plan.capability }, hintKey: 'write.capabilityHint' })
        }

        // The approval is the whole point: without a live question surface there
        // is nobody to approve, so refuse instead of writing.
        const userQuestions = ctx.get('userQuestions')
        if (!userQuestions?.ask) {
          throw new D365Error('No confirmation UI is available in this session', { i18nKey: 'write.noConfirmation', hintKey: 'write.noConfirmationHint' })
        }
        if (!exec?.agent) {
          throw new D365Error('execute requires an interactive session', { i18nKey: 'write.interactiveRequired', hintKey: 'write.interactiveHint' })
        }

        // Ask about the environment *before* the confirmation card: there is no
        // point in somebody approving a write that Dataverse will reject because
        // a Microsoft solution import is holding the customization lock.
        const env = config.environments[plan.envKey]
        const probe = new DataverseClient(env, { timeoutMs: config.timeoutMs })
        const preflight = await checkEnvironmentIdle(probe, {
          windowMinutes: config.busyWindowMinutes,
          signal: exec.signal,
        })
        if (preflight.busy && args.force !== true) throw busyError(plan.envKey, preflight)
        const busyNote = preflight.stale?.length
          ? t('write.stalePending', { count: preflight.stale.length })
          : ''

        const answer = await userQuestions.ask({
          questions: [{
            id: CONFIRM_ID,
            header: t('write.confirmHeader', { environment: plan.envKey }),
            question: t('write.confirmQuestion', { count: plan.operations.length, environment: plan.envKey }),
            detail: [describeForConfirmation(plan), busyNote].filter(Boolean).join('\n\n'),
            options: [
              { label: APPROVE(), description: t('write.approveDescription') },
              { label: CANCEL(), description: t('write.cancelDescription') },
            ],
          }],
          agent: exec.agent,
          ...(exec.signal ? { signal: exec.signal } : {}),
          wait: { callId: exec.callId },
        })

        const chosen = answer?.answers?.find((item) => item.id === CONFIRM_ID)?.selected?.[0]
        if (chosen !== APPROVE()) {
          return { text: t('write.notExecuted', { id: plan.id }) }
        }

        const result = await executePlan(config, plan, exec.signal, { force: args.force === true })
        await deletePlan(config, plan.id)
        return { text: renderExecuted(plan, result) }
      }

      const envKey = String(args.environment ?? '').trim()
      if (!envKey) throw new D365Error('environment is required', { i18nKey: 'write.environmentRequired', hintKey: 'write.available', hintParams: { values: Object.keys(config.environments).join(', ') } })

      const shared = {
        solutionUniqueName: args.solutionUniqueName ?? policy.solutionHint,
        rationale: args.rationale,
        requestedBy: args.requestedBy ?? 'agent',
        language: args.language,
      }

      if (action === 'plan-add-options') {
        const plan = await planOptionAdd(config, envKey, {
          ...shared,
          optionSetName: args.optionSet,
          entity: args.entity,
          attribute: args.attribute,
          labels: args.labels,
        }, exec?.signal)
        return finishPlan(config, plan, t('write.noOptions', { count: plan.skipped.length }))
      }

      if (action === 'plan-relabel') {
        const plan = await planOptionRelabel(config, envKey, {
          ...shared,
          optionSetName: args.optionSet,
          entity: args.entity,
          attribute: args.attribute,
          updates: args.updates,
        }, exec?.signal)
        return finishPlan(config, plan, t('write.noLabels'))
      }

      if (action === 'plan-option-delete') {
        const plan = await planOptionDelete(config, envKey, {
          ...shared,
          optionSetName: args.optionSet,
          entity: args.entity,
          attribute: args.attribute,
          values: args.values,
          acknowledge: args.acknowledge,
        }, exec?.signal)
        return finishPlan(config, plan, t('write.noOptionDeletes'))
      }

      if (action === 'plan-view-columns') {
        const plan = await planViewColumns(config, envKey, {
          ...shared,
          view: args.view,
          entity: args.entity,
          addColumns: args.addColumns,
          removeColumns: args.removeColumns,
        }, exec?.signal)
        return finishPlan(config, plan, t('write.noViewChanges'))
      }

      if (action === 'plan-add-attribute') {
        const plan = await planAddAttribute(config, envKey, {
          ...shared,
          entity: args.entity,
          schemaName: args.schemaName,
          displayName: args.displayName,
          type: args.fieldType,
          maxLength: args.maxLength,
          precision: args.precision,
          requiredLevel: args.requiredLevel,
          description: args.description,
        }, exec?.signal)
        return finishPlan(config, plan, t('write.fieldExists', { target: plan.target }))
      }

      if (action === 'plan-update-attribute') {
        const plan = await planUpdateAttribute(config, envKey, {
          ...shared,
          entity: args.entity,
          attribute: args.attribute,
          displayName: args.displayName,
          description: args.description,
          requiredLevel: args.requiredLevel,
        }, exec?.signal)
        return finishPlan(config, plan, t('write.targetUnchanged', { target: plan.target }))
      }

      if (action === 'plan-delete-attribute') {
        const plan = await planDeleteAttribute(config, envKey, {
          ...shared,
          entity: args.entity,
          attribute: args.attribute,
          acknowledge: args.acknowledge,
        }, exec?.signal)
        return finishPlan(config, plan, t('write.fieldMissing', { target: plan.target }))
      }

      if (action === 'plan-remove-layer') {
        const plan = await planRemoveLayer(config, envKey, {
          ...shared,
          componentType: args.componentType,
          component: args.component ?? (args.componentType === 'Attribute' ? args.attribute : args.entity),
          entity: args.entity,
          acknowledge: args.acknowledge,
        }, exec?.signal)
        return finishPlan(config, plan, t('write.noRemovableLayer', { target: plan.target }))
      }

      if (action === 'plan-update-entity') {
        const plan = await planUpdateEntity(config, envKey, {
          ...shared,
          entity: args.entity,
          displayName: args.displayName,
          description: args.description,
        }, exec?.signal)
        return finishPlan(config, plan, t('write.tableUnchanged', { target: plan.target }))
      }

      throw new D365Error(`Unknown action: ${action}`, { i18nKey: 'write.unknownAction', i18nParams: { action }, hintKey: 'write.available', hintParams: { values: ACTIONS.join(' / ') } })
    },
    presentCall(args = {}) {
      return { card: 'generic', title: t('write.title', { action: args.action ?? 'policy' }), kind: 'other', rawInput: args }
    },
  })
}
