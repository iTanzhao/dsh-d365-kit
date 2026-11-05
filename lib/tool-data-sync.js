/**
 * `d365_data_sync` — business records from one environment to another.
 *
 * The plan is read-only and says everything a person needs before deciding:
 * how many rows, which columns, how every lookup resolved, whether plugins will
 * be bypassed. Execution re-asks on a confirmation card, so a plan file alone
 * can never write.
 */
import { loadConfig } from './config.js'
import { D365Error } from './errors.js'
import { allows, readPolicy } from './write-policy.js'
import {
  buildPlan,
  deleteMigrationPlan,
  executeMigration,
  listMigrationPlans,
  readMigrationPlan,
  saveMigrationPlan,
  setMigrationPlanStatus,
  writePlanArtifact,
} from './data-migrate.js'

const ACTIONS = ['plan', 'show', 'list', 'cancel', 'execute']
const APPROVE = '批准执行'
const CANCEL = '取消'
const CONFIRM_ID = 'd365-data-sync-confirm'

export const definition = {
  name: 'd365_data_sync',
  description:
    '把业务记录从一个环境迁到另一个环境：默认镜像（保持 GUID），lookup 优先按 GUID 命中、其次按名称找；'
    + 'plan 只读预演，报告数据量/字段/lookup/冲突/权限/是否 Bypass 插件，并列出「条件、字段、Bypass」三项请你确认；'
    + 'execute 需人在确认卡片上批准。不指定条件时默认整表，数据量大时预演会建议加条件。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'plan 生成只读计划；show 重看计划；list 列待执行计划；cancel 取消；execute 确认后执行。默认 plan。',
      },
      source: { type: 'string', description: '源环境 key，例如 dev。' },
      target: { type: 'string', description: '目标环境 key，例如 sit。' },
      entity: { type: 'string', description: '实体逻辑名或集合名，例如 account / accounts。' },
      since: {
        type: 'string',
        description: '时间窗口起点（ISO，如 2026-11-05T00:00:00+08:00）。默认按 createdon 取；mode=modified 则按 modifiedon。',
      },
      mode: {
        type: 'string',
        enum: ['new', 'modified', 'all'],
        description: 'new=since 之后新增（createdon，默认）；modified=since 之后改动过（modifiedon）；all=整表。不给 since/filter/ids/fetchXml 时也按整表预演。',
      },
      filter: { type: 'string', description: '额外 OData $filter，例如 "statecode eq 0"。与 since 同时给会 AND 在一起。' },
      ids: { type: 'array', items: { type: 'string' }, description: '只迁这些记录的主键 GUID。' },
      fetchXml: { type: 'string', description: '用 fetchXml 精确指定要迁哪些记录（与 filter/ids 互斥优先）。' },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: '要迁的字段（逻辑名）。省略则全部可写字段。字段清单里含主键（xxxid）就等于保持 GUID 一致；不含主键则由目标分配新 GUID。',
      },
      keepGuid: { type: 'boolean', description: '不填时跟着 fields 走：字段含主键=保持 GUID（默认）；也可以显式指定。false 时由目标分配 GUID（批内引用会重映射）。' },
      includeLookups: { type: 'boolean', description: '默认 true：解析 lookup（先 GUID、再名称）。关掉则只按 GUID 判存在。' },
      ownerMode: {
        type: 'string',
        enum: ['map', 'keep', 'caller'],
        description: 'owner 处理：map=按域账号/邮箱映射到目标用户（默认，找不到落到执行账号）；keep=原样保留 GUID；caller=全部归执行账号。',
      },
      conflict: {
        type: 'string',
        enum: ['report', 'skip', 'overwrite'],
        description: '目标已存在同 GUID 时：report=只报告不写（默认）；skip=跳过；overwrite=覆盖（execute 时可用 overwrite 显式开启）。',
      },
      onMissingLookup: {
        type: 'string',
        enum: ['report', 'null', 'fail'],
        description: '引用在目标找不到且名称也匹配不上时：report=这些记录不写并报告（默认）；null=把该引用置空；fail=整个计划拒绝执行。',
      },
      bypassPlugins: {
        type: 'boolean',
        description: '默认 true（跳过目标环境的同步插件）。false 时插件照常执行，可能触发下游通知/集成。',
      },
      preserveCreatedOn: { type: 'boolean', description: '默认 true：用 overriddencreatedon 保留源创建时间。' },
      suppressDuplicateDetection: { type: 'boolean', description: '默认 true：请求带 MSCRM.SuppressDuplicateDetection，避免目标环境的重复检测规则拒掉创建。' },
      includeState: { type: 'boolean', description: '默认 false：不搬 statecode/statuscode（一律按目标默认状态创建）。' },
      maxRecords: { type: 'integer', description: '单次最多读取多少条，默认 500，上限 5000。' },
      concurrency: { type: 'integer', description: '写请求并发数，默认 4，上限 8。' },
      planId: { type: 'string', description: 'show / cancel / execute：计划 id。' },
      rationale: { type: 'string', description: '为什么要迁，会写进计划与执行记录。' },
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

function yesNo(value) {
  return value ? '是' : '否'
}

function willWrite(plan, options) {
  const blocked = options.onMissingLookup === 'report' ? plan.counts.blocked : 0
  const overwrite = options.conflict === 'overwrite' ? plan.counts.conflict : 0
  return plan.counts.create - blocked + overwrite
}

function renderPlan(plan) {
  const { counts, options, lookupSummary, fields, owners, limits } = plan
  const lines = [`数据迁移计划：${plan.id}（只读预演，尚未写入）`]
  lines.push(`源 → 目标：${plan.source.key}（${plan.source.entity}）→ ${plan.target.key}（${plan.target.entity}）`)
  if (plan.rationale) lines.push(`理由：${plan.rationale}`)
  lines.push(`范围：${plan.scope.description}`)
  lines.push(`读取：${limits.read} 条${limits.hasMore ? `（已达上限 ${limits.maxRecords}，还有更多未读；请缩小范围或调大 maxRecords）` : ''}`)
  lines.push('')

  lines.push('| 项 | 数量 |')
  lines.push('| --- | --- |')
  lines.push(`| 实际会写入 | ${willWrite(plan, options)} |`)
  lines.push(`| 将新建 | ${counts.create} |`)
  lines.push(`| 其中因引用缺失暂不写 | ${counts.blocked} |`)
  lines.push(`| 目标已存在同 GUID | ${counts.conflict}${options.conflict === 'overwrite' ? '（execute 时覆盖）' : '（报告，不覆盖）'} |`)
  lines.push(`| 引用缺失/歧义合计 | ${counts.missingLookups} |`)
  lines.push('')

  const plain = fields.filter((field) => !field.lookup).map((field) => field.name)
  const lookups = fields.filter((field) => field.lookup)
  const plainText = plain.length > 40
    ? `${plain.slice(0, 40).join(', ')} …（其余 ${plain.length - 40} 个见完整计划）`
    : (plain.join(', ') || '（无普通字段）')
  lines.push(`字段（${fields.length} 个，${lookups.length} 个 lookup）：${plainText}`)
  if (lookups.length) {
    lines.push(`lookup（${lookups.length} 个）：${lookups.map((field) => `${field.name}(${field.targets.join('|') || '?'})`).join(', ')}`)
  }
  lines.push('')

  if (lookupSummary.length) {
    lines.push('Lookup 情况：')
    lines.push('| 字段 | 有值 | GUID 命中 | 按名称命中 | 缺失 | 歧义 | 为空 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const entry of lookupSummary) {
      lines.push(`| ${entry.attribute} | ${entry.filled} | ${entry.sameGuid} | ${entry.byName} | ${entry.missing} | ${entry.ambiguous} | ${entry.empty} |`)
    }
    const samples = lookupSummary.flatMap((entry) => (entry.missingSamples ?? []).map((sample) => ({ ...sample, attribute: entry.attribute })))
    if (samples.length) {
      lines.push('')
      lines.push('未解析的引用（示例）：')
      for (const sample of samples.slice(0, 10)) {
        lines.push(`- ${sample.attribute}：${sample.name ?? sample.sourceId} — ${sample.reason ?? '目标里找不到'}`)
      }
    }
    lines.push('')
  }

  if (owners.distinct) {
    lines.push(`Owner：${owners.distinct} 个所有者，映射到目标 ${owners.mapped} 个，兜底 ${owners.fallback} 个（${options.ownerMode === 'caller' ? '全部归执行账号' : '落到执行账号'}）。`)
    lines.push('')
  }

  lines.push('写入选项：')
  lines.push(`- 保持 GUID：${yesNo(options.keepGuid)}${options.keepGuid ? '' : '（目标重新分配，批内引用会重映射）'}`)
  lines.push(`- 保留创建时间（overriddencreatedon）：${yesNo(options.preserveCreatedOn)}`)
  lines.push(`- Bypass 自定义插件：${yesNo(options.bypassPlugins)}${options.bypassPlugins ? '（目标环境不会触发同步插件）' : '（插件照常执行，可能触发下游通知/集成）'}`)
  lines.push(`- 抑制重复检测：${yesNo(options.suppressDuplicateDetection)}`)
  lines.push(`- 冲突处理：${options.conflict}`)
  lines.push(`- 缺失引用：${options.onMissingLookup}`)
  lines.push(`- 搬状态字段：${yesNo(options.includeState)}`)
  lines.push(`- 并发：${options.concurrency}`)
  lines.push('')

  const warnings = plan.warnings ?? []
  if (warnings.length) {
    lines.push('需要注意：')
    for (const warning of warnings) lines.push(`- ${warning}`)
    lines.push('')
  }

  const permissions = plan.permissions
  if (permissions) {
    const read = (key) => (permissions[key] ? '已开启' : '未开启')
    lines.push('权限（execute 需要）：')
    lines.push(`- 读取 ${plan.source.key}（data.read）：${read('sourceRead')}`)
    lines.push(`- 读取 ${plan.target.key}（data.read）：${read('targetRead')}`)
    lines.push(`- 写入 ${plan.target.key}（data.write）：${permissions.targetWrite
      ? '已开启'
      : '未开启 —— 执行前要在设置页「权限」里给该环境勾上「新增/修改业务数据」'}`)
    lines.push('')
  }

  lines.push('请确认这三项（下面是本次预演用的值；要改任何一项，重新 plan）：')
  lines.push(`- 迁移条件：${plan.scope.description}${plan.scope.implicit ? '；数据量大建议用 since / filter / ids / fetchXml 加条件' : ''}`)
  lines.push(`- 迁移字段：${fields.length} 个${options.keepGuid
    ? `（含主键 ${plan.idField ?? `${plan.source.entity}id`} → 保持 GUID 一致）`
    : '（不含主键 → 目标重新分配 GUID，批内引用会重映射）'}`)
  lines.push(`- Bypass 自定义插件：${yesNo(options.bypassPlugins)}${options.bypassPlugins ? '（默认跳过目标环境的同步插件）' : ''}`)
  lines.push('')

  if (permissions && !permissions.targetWrite) {
    lines.push(`执行前请先在设置页「权限」里给 ${plan.target.key} 勾上「新增/修改业务数据」，否则 execute 会被拦下。`)
  } else {
    lines.push('确认无误后告诉我执行，我会弹确认卡片（写明写入条数、字段数、lookup 命中、是否 Bypass）。')
  }
  lines.push('这一步没有写任何东西。')
  return lines.join('\n')
}

function renderConfirmation(plan, options) {
  const created = plan.counts.create - (options.onMissingLookup === 'report' ? plan.counts.blocked : 0)
  const overwritten = options.conflict === 'overwrite' ? plan.counts.conflict : 0
  const lines = [`${plan.source.key} → ${plan.target.key}（${plan.target.entity}）`]
  lines.push(`范围：${plan.scope.description}`)
  lines.push(`将写入 ${created + overwritten} 条：新建 ${created} 条${overwritten ? `，覆盖 ${overwritten} 条` : ''}`)
  if (options.conflict !== 'overwrite' && plan.counts.conflict) {
    lines.push(`另有 ${plan.counts.conflict} 条目标已存在同 GUID，会跳过（要覆盖请改用 conflict="overwrite" 重新执行）。`)
  }
  if (options.onMissingLookup === 'report' && plan.counts.blocked) {
    lines.push(`${plan.counts.blocked} 条因引用缺失会跳过。`)
  }
  lines.push(`字段 ${plan.fields.length} 个；lookup 命中：GUID ${plan.lookupSummary.reduce((sum, item) => sum + item.sameGuid, 0)}，按名称 ${plan.lookupSummary.reduce((sum, item) => sum + item.byName, 0)}。`)
  lines.push(`Bypass 自定义插件：${yesNo(options.bypassPlugins)}`)
  lines.push(`保持 GUID：${yesNo(options.keepGuid)}；保留创建时间：${yesNo(options.preserveCreatedOn)}；抑制重复检测：${yesNo(options.suppressDuplicateDetection)}`)
  lines.push('', '确认后立即写入目标环境；业务数据写入没有待确认计划，也不会自动回滚。')
  return lines.join('\n')
}

function renderRun(plan, run) {
  const lines = [`已执行迁移计划 ${plan.id}（${run.runId}）`]
  lines.push(`写入 ${run.counts.written} 条（新建 ${run.created.length} / 覆盖 ${run.updated.length}），跳过 ${run.counts.skipped} 条，失败 ${run.counts.failed} 条。`)
  if (run.skippedRecords.length) {
    lines.push('')
    lines.push(`跳过的记录（前 5 条）：${run.skippedRecords.slice(0, 5).map((record) => `${record.id} — ${record.reason}`).join('；')}`)
  }
  if (run.failures.length) {
    lines.push('')
    lines.push('失败：')
    for (const failure of run.failures.slice(0, 10)) lines.push(`- ${failure.id}：${failure.error}`)
    if (run.failures.length > 10) lines.push(`- … 其余 ${run.failures.length - 10} 条见执行记录`)
  }
  lines.push('', `执行记录：${run.file}`)
  return lines.join('\n')
}

function checkEnvironments(config, args) {
  const sourceKey = String(args.source ?? '').trim()
  const targetKey = String(args.target ?? '').trim()
  if (!sourceKey || !targetKey) {
    throw new D365Error('需要 source 和 target', {
      code: 'missing-environment',
      hint: `例如 source="dev" target="sit"；可用：${Object.keys(config.environments).join(', ')}`,
    })
  }
  if (sourceKey === targetKey) throw new D365Error('source 和 target 是同一个环境', { code: 'same-environment' })
  if (!config.environments[sourceKey]) throw new D365Error(`源环境不存在：${sourceKey}`, { hint: `可用：${Object.keys(config.environments).join(', ')}` })
  if (!config.environments[targetKey]) throw new D365Error(`目标环境不存在：${targetKey}`, { hint: `可用：${Object.keys(config.environments).join(', ')}` })
  return { sourceKey, targetKey }
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args = {}, exec) {
      const config = await loadConfig(state.rawConfig)
      const action = args.action ?? 'plan'
      const policy = await readPolicy(config.configFile)

      if (action === 'list') {
        const plans = await listMigrationPlans(config)
        if (!plans.length) return { text: '没有待执行的数据迁移计划。' }
        const pending = plans.filter((plan) => (plan.status ?? 'pending') === 'pending')
        const lines = [`待执行的数据迁移：${pending.length} 个计划`, '']
        for (const plan of plans) {
          const stateLabel = plan.status === 'pending' ? '' : plan.status === 'running' ? ' · 执行中断，先核对执行记录' : plan.status === 'failed' ? ' · 上次执行失败' : ' · 已执行'
          lines.push(`- ${plan.id}：${plan.source.key} → ${plan.target.key}（${plan.target.entity}），`
            + `${plan.counts.create} 新建 / ${plan.counts.conflict} 冲突，范围 ${plan.scope.description}${stateLabel}`)
        }
        lines.push('', '先 action=show 看细节，确认后 action=execute。')
        return { text: lines.join('\n') }
      }

      if (action === 'show') {
        const id = String(args.planId ?? '').trim()
        if (!id) throw new D365Error('show 需要 planId', { hint: '用 action=list 查看现有计划' })
        const plan = await readMigrationPlan(config, id)
        if (!plan) throw new D365Error(`没有找到计划 ${id}`, { code: 'plan-not-found', hint: '用 action=list 查看现有计划' })
        return { text: renderPlan(plan) }
      }

      if (action === 'cancel') {
        const id = String(args.planId ?? '').trim()
        if (!id) throw new D365Error('cancel 需要 planId')
        const removed = await deleteMigrationPlan(config, id)
        return { text: removed ? `已取消计划 ${id}。` : `没有找到计划 ${id}。` }
      }

      if (action === 'execute') {
        const id = String(args.planId ?? '').trim()
        if (!id) throw new D365Error('execute 需要 planId', { hint: '先 action=plan 生成计划，再 action=execute' })
        const plan = await readMigrationPlan(config, id)
        if (!plan) throw new D365Error(`没有找到计划 ${id}`, { code: 'plan-not-found', hint: '用 action=list 查看现有计划' })
        if ((plan.status ?? 'pending') !== 'pending') {
          throw new D365Error(`计划 ${id} 不是待执行状态（${plan.status}）`, {
            code: 'plan-not-pending',
            hint: '上次执行可能中断或已完成；先到 .d365/data-sync/runs 核对结果，需要重跑请重新 plan。',
          })
        }
        const targetKey = plan.target.key
        if (!allows(policy, targetKey, 'data.write')) {
          throw new D365Error(`环境 ${targetKey} 未授权新增或修改业务数据`, {
            code: 'data-write-forbidden',
            hint: `在设置页「权限」里给 ${targetKey} 勾上「新增/修改业务数据」后再试。`,
          })
        }

        // Execute-time options can narrow what the plan proposed (overwrite,
        // bypass) but the card always states the final values.
        const effective = {
          conflict: ['report', 'skip', 'overwrite'].includes(args.conflict) ? args.conflict : plan.options.conflict,
          onMissingLookup: ['report', 'null', 'fail'].includes(args.onMissingLookup) ? args.onMissingLookup : plan.options.onMissingLookup,
          bypassPlugins: typeof args.bypassPlugins === 'boolean' ? args.bypassPlugins : plan.options.bypassPlugins,
          concurrency: Number.isFinite(args.concurrency)
            ? Math.max(1, Math.min(8, Number(args.concurrency)))
            : plan.options.concurrency,
        }

        const userQuestions = ctx.get('userQuestions')
        if (!userQuestions?.ask) {
          throw new D365Error('当前会话没有可用的确认界面', { hint: '数据迁移必须在对话里确认，没有「存起来稍后执行」的路径。' })
        }
        if (!exec?.agent) throw new D365Error('execute 需要可交互的会话', { hint: '请在主对话里执行。' })

        const answer = await userQuestions.ask({
          questions: [{
            id: CONFIRM_ID,
            header: `确认迁移 ${plan.source.key} → ${plan.target.key}`,
            question: `要执行这个计划、把记录写入 ${plan.target.key} 吗？`,
            detail: renderConfirmation(plan, effective),
            options: [
              { label: APPROVE, description: '立即写入目标环境' },
              { label: CANCEL, description: '不执行，计划继续保留' },
            ],
          }],
          agent: exec.agent,
          ...(exec.signal ? { signal: exec.signal } : {}),
          wait: { callId: exec.callId },
        })
        const chosen = answer?.answers?.find((item) => item.id === CONFIRM_ID)?.selected?.[0]
        if (chosen !== APPROVE) return { text: `未执行。计划 ${id} 仍在待执行列表里。` }

        await setMigrationPlanStatus(config, id, 'running')
        try {
          const run = await executeMigration(config, plan, effective, exec.signal)
          await setMigrationPlanStatus(config, id, 'done', { runId: run.runId, executedAt: run.at })
          return { text: renderRun(plan, run) }
        } catch (error) {
          await setMigrationPlanStatus(config, id, 'failed', { error: String(error?.message ?? error) })
          throw error
        }
      }

      // action === 'plan'
      const { sourceKey, targetKey } = checkEnvironments(config, args)
      for (const key of [sourceKey, targetKey]) {
        if (!allows(policy, key, 'data.read')) {
          throw new D365Error(`环境 ${key} 未授权读取业务数据`, {
            code: 'data-read-forbidden',
            hint: `生成计划要读源和目标的记录（含存在性检查），请在设置页「权限」里给 ${key} 勾上「读取业务数据」。`,
          })
        }
      }
      // A missing `data.write` on the target is not fatal for a plan: the report
      // says so, and `execute` refuses with the same hint.

      const built = await buildPlan(config, { ...args, source: sourceKey, target: targetKey }, exec?.signal)
      built.permissions = {
        sourceRead: allows(policy, sourceKey, 'data.read'),
        targetRead: allows(policy, targetKey, 'data.read'),
        targetWrite: allows(policy, targetKey, 'data.write'),
      }
      const plan = await saveMigrationPlan(config, { ...built, rationale: args.rationale })
      const artifact = await writePlanArtifact(config, plan)
      const text = `${renderPlan(plan)}\n完整计划（含每条记录）：${artifact}`
      return { text }
    },
    presentCall(args = {}) {
      return { card: 'generic', title: `D365 数据迁移：${args.action ?? 'plan'}`, kind: 'other', rawInput: args }
    },
  })
}
