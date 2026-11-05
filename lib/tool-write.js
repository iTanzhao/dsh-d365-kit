/**
 * `d365_write` — the agent's write surface.
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

const APPROVE = '批准执行'
const CANCEL = '取消'
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
  name: 'd365_write',
  description:
    '准备并执行 D365 元数据变更：选项集增/改/删值（全局或字段本地）、新增字段、改字段显示名、删除字段、改表显示名、调整系统视图的列、移除组件最上面的自定义层。'
    + 'plan-* 只生成计划、不写入；execute 会在对话里弹出确认卡片，必须由人点「批准执行」才会真正写入。'
    + '可用的环境与能力受设置页「权限」控制。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description:
          'policy 看权限；plan-add-options 新增选项值；plan-relabel 改选项标签；'
          + 'plan-option-delete 删除选项值（高危，需 acknowledge）；'
          + 'plan-add-attribute 新增字段；plan-update-attribute 改字段显示名；'
          + 'plan-delete-attribute 删除字段（高危，需 acknowledge）；'
          + 'plan-remove-layer 移除组件最上面的未受管自定义层（高危，需 acknowledge，只支持表与字段）；'
          + 'plan-update-entity 改表显示名；'
          + 'plan-view-columns 增删系统视图的列；list 列待确认计划；execute 在对话里请求确认后执行；cancel 取消。默认 policy。',
      },
      environment: { type: 'string', description: '目标环境 key，例如 dev。' },
      optionSet: { type: 'string', description: '全局选项集名称，例如 contoso_taxcategoryos。字段本地选项集改用 entity + attribute。' },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'plan-add-options：要新增的选项，每项形如 "AD3|Andorra: Tax Register Number (NRT)"。已存在的代码会被跳过。',
      },
      updates: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            value: { type: 'integer', description: '现有选项值。' },
            label: { type: 'string', description: '新标签。' },
          },
        },
        description: 'plan-relabel：要改标签的选项列表。',
      },
      values: {
        type: 'array',
        items: { type: 'integer' },
        description: 'plan-option-delete：要删除的选项值列表。',
      },
      view: {
        type: 'string',
        description: 'plan-view-columns：系统视图名称，例如「Active Accounts」。',
      },
      addColumns: {
        type: 'array',
        items: { type: 'string' },
        description: 'plan-view-columns：要加进视图的字段逻辑名。',
      },
      removeColumns: {
        type: 'array',
        items: { type: 'string' },
        description: 'plan-view-columns：要从视图里去掉的字段逻辑名。',
      },
      entity: {
        type: 'string',
        description: '表逻辑名，例如 account（字段、表、本地选项集相关操作需要）。',
      },
      attribute: {
        type: 'string',
        description: '字段逻辑名。plan-update-attribute / plan-delete-attribute 用；与 entity 一起也可指向字段的本地选项集。',
      },
      fieldType: {
        type: 'string',
        enum: ['string', 'memo', 'integer', 'decimal', 'money', 'boolean', 'datetime'],
        description: 'plan-add-attribute：字段类型，默认 string。',
      },
      schemaName: {
        type: 'string',
        description: 'plan-add-attribute：字段的 SchemaName，必须带发布者前缀，例如 new_TestField。',
      },
      displayName: {
        type: 'string',
        description: '显示名。新增字段时默认等于 schemaName；修改时只改传入的项。',
      },
      description: { type: 'string', description: '描述（可选）。' },
      maxLength: { type: 'integer', description: 'string/memo 的最大长度，默认 100 / 2000。' },
      precision: { type: 'integer', description: 'decimal/money 的小数位，默认 2。' },
      requiredLevel: {
        type: 'string',
        enum: ['None', 'Recommended', 'Required'],
        description: '必填级别，默认 None。',
      },
      language: {
        type: 'integer',
        description: '标签语言代码，默认 1033；中文环境可用 2052。',
      },
      acknowledge: {
        type: 'boolean',
        description: 'plan-delete-attribute / plan-remove-layer 必须显式传 true：这两个操作不可恢复。',
      },
      componentType: {
        type: 'string',
        enum: ['Entity', 'Attribute'],
        description: 'plan-remove-layer：组件类型，Entity（表）或 Attribute（字段），默认 Entity。',
      },
      component: {
        type: 'string',
        description: 'plan-remove-layer：要移除层的组件名。Entity 时是表逻辑名（如 account）；Attribute 时是字段逻辑名（需同时给 entity）。',
      },
      solutionUniqueName: {
        type: 'string',
        description: '承载改动的未受管解决方案唯一名。传了改动才能随解决方案导出。',
      },
      rationale: { type: 'string', description: '变更理由，会写进计划与变更记录。' },
      planId: { type: 'string', description: 'execute / cancel：目标计划 id。' },
      force: {
        type: 'boolean',
        description: 'execute：跳过"环境正在发布/导入"的执行前检查。只在确认那条发布记录是残留时才用。',
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
  const lines = ['环境权限（在设置页「权限」里修改）：', '']
  lines.push('| 环境 | 已授权能力 |')
  lines.push('| --- | --- |')
  for (const row of rows) {
    const grants = row.capabilities.length
      ? row.capabilities.map((key) => `${CAPABILITIES[key].label}（${key}）`).join('；')
      : '只读'
    lines.push(`| ${row.environment} | ${grants} |`)
  }
  lines.push('')
  lines.push('可用能力：')
  let group
  for (const [key, value] of Object.entries(CAPABILITIES)) {
    if (value.group !== group) {
      group = value.group
      lines.push(`- ${group}`)
    }
    lines.push(`  - ${key}：${value.label} — ${value.description}${value.risk === 'high' ? '（高危）' : ''}`)
  }
  if (policy.solutionHint) lines.push(`默认解决方案：${policy.solutionHint}`)
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
  if (plan.optionSetName) return `选项集：${plan.optionSetName}`
  if (plan.entity && plan.attribute) return `选项集：${plan.entity}.${plan.attribute}（本地）`
  if (plan.target) return `目标：${plan.target}`
  return null
}

function renderOperation(operation) {
  const verb = VERBS[operation.type] ?? '·'
  const text = operation.summary ?? `${operation.type} ${operation.value ?? ''}`.trim()
  return `${verb} ${text}`
}

function renderSkips(plan) {
  const lines = []
  for (const skip of plan.skipped ?? []) {
    if (skip.code !== undefined) lines.push(`= ${skip.code} 已存在（值 ${skip.value}）`)
    else lines.push(`- ${skip.schemaName ?? skip.attribute ?? skip.entity ?? skip.value ?? ''} 跳过：${skip.reason ?? ''}`)
  }
  return lines
}

function renderPlan(plan) {
  const lines = [`计划已生成：${plan.id}`]
  lines.push(`环境：${plan.envKey}（${plan.envUrl}）`)
  const scope = planScope(plan)
  if (scope) lines.push(scope)
  lines.push(`操作：${plan.operations.length} 个${plan.skipped?.length ? `，跳过 ${plan.skipped.length} 个` : ''}`)
  lines.push('')

  for (const operation of plan.operations) lines.push(renderOperation(operation))
  lines.push(...renderSkips(plan))
  lines.push('')
  lines.push('这一步没有写入任何东西。可以说「执行这个计划」，我会弹出确认卡片；也可以到设置 →「D365 环境」→「待确认的写入」里点确认。')
  return lines.join('\n')
}

/**
 * The text of the in-chat confirmation card. This is the only place a person
 * sees exactly what will be written before approving, so it lists operations
 * rather than a count.
 */
function describeForConfirmation(plan) {
  const lines = [`环境：${plan.envKey}（${plan.envUrl}）`]
  const scope = planScope(plan)
  if (scope) lines.push(scope)
  lines.push(`操作：${plan.operations.length} 条`)
  for (const operation of plan.operations.slice(0, 10)) lines.push(renderOperation(operation))
  if (plan.operations.length > 10) lines.push(`… 其余 ${plan.operations.length - 10} 条`)
  if (plan.operations.some((operation) => DESTRUCTIVE.has(operation.type))) {
    lines.push('', '注意：包含不可恢复的操作（删除，或移除自定义层），删掉的内容无法找回。')
  }
  lines.push('', '确认后立即写入该环境，元数据变更无法自动回滚。')
  return lines.join('\n')
}

function renderExecuted(plan, result) {
  const lines = [`已执行计划 ${plan.id}：成功 ${result.results.length} 条，失败 ${result.failures.length} 条。`]
  if (result.failures.length) {
    lines.push('')
    for (const failure of result.failures) {
      lines.push(`! ${failure.operation?.summary ?? failure.operation?.type ?? '操作'}：${failure.error}`)
    }
  }
  if (result.publishState === 'running') {
    const scope = result.publishScope ?? { entities: [], optionSets: [] }
    const targets = [
      ...scope.entities,
      ...scope.optionSets.map((name) => `选项集 ${name}`),
    ]
    lines.push('', targets.length
      ? `已在后台发布：${targets.join('、')}。`
      : '已在后台发布全部组件，稍后生效。')
  } else {
    lines.push('', '没有需要发布的内容。')
  }
  if (result.preflight?.forced) lines.push('注意：已跳过执行前的环境发布检查（force）。')
  else if (result.preflight?.stale) {
    lines.push(`注意：环境里有 ${result.preflight.stale} 条更早仍未结束的发布记录，可能是残留，本次没有阻塞执行。`)
  }
  if (result.ledger) lines.push(`变更记录：${result.ledger}`)
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
        if (!plans.length) return { text: '没有待确认的写入计划。' }
        const pending = plans.filter((plan) => (plan.status ?? 'pending') === 'pending')
        const lines = [`待确认的写入：${pending.length} 个计划${plans.length > pending.length ? `（另有 ${plans.length - pending.length} 个已执行或中断，需人工处理）` : ''}`, '']
        for (const plan of plans) {
          const state = (plan.status ?? 'pending') === 'pending'
            ? ''
            : plan.status === 'running' ? ' · 执行中断，先核对账本' : plan.status === 'failed' ? ' · 执行失败，先核对账本' : ' · 已执行'
          lines.push(`- ${plan.id}（${plan.envKey}，${CAPABILITIES[plan.capability]?.label ?? plan.kind}，${plan.operations.length} 个操作）${plan.title ?? ''}${state}`)
        }
        lines.push('', '说「执行 <id>」我会在对话里弹确认卡片；也可以到设置页「待确认的写入」里操作。')
        return { text: lines.join('\n') }
      }

      if (action === 'cancel') {
        const id = String(args.planId ?? '').trim()
        if (!id) throw new D365Error('cancel 需要 planId')
        const removed = await deletePlan(config, id)
        return { text: removed ? `已取消计划 ${id}。` : `没有找到计划 ${id}。` }
      }

      if (action === 'execute') {
        const id = String(args.planId ?? '').trim()
        if (!id) throw new D365Error('execute 需要 planId', { hint: '先用 list 查看待确认的计划，或直接让 agent 生成一个计划' })
        const plan = (await listPlans(config)).find((item) => item.id === id)
        if (!plan) throw new D365Error(`没有找到计划 ${id}`, { hint: '计划可能已经执行或取消；用 list 查看当前待确认列表' })
        if (plan.status !== 'pending') {
          const label = plan.status === 'running'
            ? '正在执行，或上次执行中途中断'
            : plan.status === 'failed' ? '上次执行失败' : '已经执行过'
          throw new D365Error(`计划 ${plan.id} ${label}`, {
            code: 'plan-not-pending',
            hint: '先核对 .d365/changes 里的执行记录；要再做一次，请取消该计划并重新生成，不要在原计划上重跑。',
          })
        }
        if (!allows(policy, plan.envKey, plan.capability)) {
          throw new D365Error(`环境 ${plan.envKey} 未授权 ${plan.capability}`, { hint: '在设置页「权限」里勾选后再试' })
        }

        // The approval is the whole point: without a live question surface there
        // is nobody to approve, so refuse instead of writing.
        const userQuestions = ctx.get('userQuestions')
        if (!userQuestions?.ask) {
          throw new D365Error('当前会话没有可用的确认界面', { hint: '请在设置页「待确认的写入」里执行这个计划' })
        }
        if (!exec?.agent) {
          throw new D365Error('execute 需要可交互的会话', { hint: '请在主对话里执行，或到设置页操作' })
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
          ? `注意：环境里有 ${preflight.stale.length} 条更早仍未结束的发布记录，可能是残留。`
          : ''

        const answer = await userQuestions.ask({
          questions: [{
            id: CONFIRM_ID,
            header: `确认写入 ${plan.envKey}`,
            question: `要在 ${plan.envKey} 执行这 ${plan.operations.length} 条元数据修改吗？`,
            detail: [describeForConfirmation(plan), busyNote].filter(Boolean).join('\n\n'),
            options: [
              { label: APPROVE, description: '立即写入该环境，并在后台发布' },
              { label: CANCEL, description: '不执行，计划继续留在待确认列表' },
            ],
          }],
          agent: exec.agent,
          ...(exec.signal ? { signal: exec.signal } : {}),
          wait: { callId: exec.callId },
        })

        const chosen = answer?.answers?.find((item) => item.id === CONFIRM_ID)?.selected?.[0]
        if (chosen !== APPROVE) {
          return { text: `未执行。计划 ${plan.id} 仍保留在待确认列表里，随时可以再确认或取消。` }
        }

        const result = await executePlan(config, plan, exec.signal, { force: args.force === true })
        await deletePlan(config, plan.id)
        return { text: renderExecuted(plan, result) }
      }

      const envKey = String(args.environment ?? '').trim()
      if (!envKey) throw new D365Error('需要 environment', { hint: `可用：${Object.keys(config.environments).join(', ')}` })

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
        return finishPlan(config, plan, `没有需要新增的选项：${plan.skipped.length} 个代码都已存在。`)
      }

      if (action === 'plan-relabel') {
        const plan = await planOptionRelabel(config, envKey, {
          ...shared,
          optionSetName: args.optionSet,
          entity: args.entity,
          attribute: args.attribute,
          updates: args.updates,
        }, exec?.signal)
        return finishPlan(config, plan, '没有需要修改的标签：给出的值都不存在，或者标签与现有值相同。')
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
        return finishPlan(config, plan, `没有生成操作：给出的值都已在选项集中不存在。`)
      }

      if (action === 'plan-view-columns') {
        const plan = await planViewColumns(config, envKey, {
          ...shared,
          view: args.view,
          entity: args.entity,
          addColumns: args.addColumns,
          removeColumns: args.removeColumns,
        }, exec?.signal)
        return finishPlan(config, plan, '没有需要调整的列：要加的都已存在，要删的都不存在。')
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
        return finishPlan(config, plan, `没有生成操作：字段 ${plan.target} 已存在。`)
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
        return finishPlan(config, plan, `没有需要修改的内容：${plan.target} 的值与现值相同。`)
      }

      if (action === 'plan-delete-attribute') {
        const plan = await planDeleteAttribute(config, envKey, {
          ...shared,
          entity: args.entity,
          attribute: args.attribute,
          acknowledge: args.acknowledge,
        }, exec?.signal)
        return finishPlan(config, plan, `没有生成操作：字段 ${plan.target} 不存在。`)
      }

      if (action === 'plan-remove-layer') {
        const plan = await planRemoveLayer(config, envKey, {
          ...shared,
          componentType: args.componentType,
          component: args.component ?? (args.componentType === 'Attribute' ? args.attribute : args.entity),
          entity: args.entity,
          acknowledge: args.acknowledge,
        }, exec?.signal)
        return finishPlan(config, plan, `没有生成操作：${plan.target} 没有可移除的自定义层。`)
      }

      if (action === 'plan-update-entity') {
        const plan = await planUpdateEntity(config, envKey, {
          ...shared,
          entity: args.entity,
          displayName: args.displayName,
          description: args.description,
        }, exec?.signal)
        return finishPlan(config, plan, `没有需要修改的内容：表 ${plan.target} 的值与现值相同。`)
      }

      throw new D365Error(`未知 action：${action}`, { hint: `可用：${ACTIONS.join(' / ')}` })
    },
    presentCall(args = {}) {
      return { card: 'generic', title: `D365 写入：${args.action ?? 'policy'}`, kind: 'other', rawInput: args }
    },
  })
}
