/**
 * `d365_access` — who holds which security role, what a role may do, and the
 * plans that change either.
 *
 * Read actions answer the questions that actually come up ("who has Data
 * Stewards", "what can Salesperson write, at what depth"). Write actions are
 * plans first: assigning a role or changing a privilege opens a confirmation
 * card in the chat, because a wrong click here grants data access rather than
 * merely failing.
 */
import { loadConfig } from './config.js'
import { D365Error } from './errors.js'
import {
  ACCESS_CAPABILITY,
  executeAccessPlan,
  listRoles,
  planPrivileges,
  planRoleMembership,
  resolveRoles,
  rolePrivileges,
  saveAccessPlan,
  userRoles,
  whoHasRole,
} from './access.js'
import { formatTable } from './runtime.js'
import { allows, readPolicy } from './write-policy.js'
import { deletePlan, listPlans } from './write-store.js'

const ACTIONS = [
  'roles',
  'who-has-role',
  'user-roles',
  'role-privileges',
  'plan-assign-role',
  'plan-remove-role',
  'plan-add-privileges',
  'plan-remove-privileges',
  'list',
  'show',
  'cancel',
  'execute',
]

const APPROVE = '确认修改'
const CANCEL = '取消'
const CONFIRM_ID = 'd365-access-confirm'

const RIGHTS = ['创建', '读', '写', '删除', '追加', '追加到', '指派', '共享']

export const definition = {
  name: 'd365_access',
  description:
    '查和改 Dataverse 安全角色：谁拥有某个角色（含通过团队继承的人）、某个用户有哪些角色、某个角色能对哪些表做什么（按创建/读/写/删除/追加/追加到/指派/共享，以及本人/本部门/本部门及下级/组织四级深度）。'
    + 'plan-* 只生成计划、不写入；execute 会在对话里弹出确认卡片，必须由人点「确认修改」才会真正写入。'
    + '读取需要「读取业务数据」；写入需要「改安全角色」（默认关闭）。同名角色按业务部门各有一份，写入时必须能定位到唯一一条。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'roles / who-has-role / user-roles / role-privileges 是只读查询；plan-* 出计划；execute 需人在确认卡片上批准。',
      },
      environment: { type: 'string', description: '环境 key，例如 dev；省略则用默认环境。' },
      role: { type: 'string', description: '角色名或 roleid。同名角色在多个业务部门各有一份；配合 businessunit 或直接用 roleid 定位唯一一条。' },
      businessunit: { type: 'string', description: '业务部门名或 GUID：同名角色按部门各有一份，用它把角色钉到某一部门（例如 AP）。' },
      user: { type: 'string', description: '用户：GUID、域名账号（user@contoso.com）或姓名。查询时模糊匹配，写入时要求唯一。' },
      team: { type: 'string', description: '团队：GUID 或名称。给了 team 就忽略 user，按团队处理。' },
      entity: { type: 'string', description: 'role-privileges 只看某张表：表的逻辑名，例如 account。' },
      privileges: {
        type: 'array',
        description: 'plan-add-privileges / plan-remove-privileges 要处理的权限：字符串 "prvWriteAccount"，或对象 {"name":"prvWriteAccount","depth":"global"}。名字来自 role-privileges 的输出。',
        items: {
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                depth: { type: 'string', description: 'basic（本人）/ local（本部门）/ deep（本部门及下级）/ global（组织）。省略时：新增用已有深度或 global，移除不看深度。' },
              },
              required: ['name'],
            },
          ],
        },
      },
      name: { type: 'string', description: 'roles：按名称包含匹配（等价于 filter contains(name,...)）。' },
      filter: { type: 'string', description: 'roles：额外的 OData $filter，例如 contains(name,\'Sales\')。' },
      top: { type: 'integer', description: 'roles 返回多少个角色记录，默认 200，最多 1000。' },
      planId: { type: 'string', description: 'show / cancel / execute 的计划 id。' },
      rationale: { type: 'string', description: '为什么要改，会写进计划和变更记录。' },
    },
    required: ['action'],
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

function renderRoles(result) {
  const lines = [`角色：${result.groups.length} 个名称 / ${result.rows.length} 条记录`]
  lines.push('Dataverse 给每个业务部门各存一份同名角色，所以「Salesperson」可能出现多次，权限也各算各的。')
  lines.push('')
  lines.push(formatTable(
    result.groups.map((group) => ({
      名称: group.name,
      份数: group.total,
      托管: group.managed,
      业务部门: group.units.slice(0, 6).join('、') + (group.units.length > 6 ? ` 等 ${group.units.length} 个` : ''),
    })),
    ['名称', '份数', '托管', '业务部门'],
    { width: 48 },
  ))
  return lines.join('\n')
}

function renderWhoHas(result) {
  const lines = [`角色：${result.label}`]
  lines.push(`直接拥有该角色的用户：${result.directUsers.length} 人`)
  const enabled = result.directUsers.filter((user) => !user.isdisabled)
  if (enabled.length) {
    lines.push(formatTable(
      enabled.slice(0, 30).map((user) => ({ 姓名: user.fullname, 账号: user.domainname ?? '—' })),
      ['姓名', '账号'],
      { width: 44 },
    ))
    if (enabled.length > 30) lines.push(`… 其余 ${enabled.length - 30} 人见完整结果`)
  }
  lines.push('')
  lines.push(`拥有该角色的团队：${result.teams.length} 个`)
  if (result.teams.length) {
    lines.push(formatTable(
      result.teams.map((team) => ({ 团队: team.name, 类型: team.teamtype === 2 ? '所有者' : '访问', 成员: team.memberCount })),
      ['团队', '类型', '成员'],
      { width: 44 },
    ))
  }
  lines.push('')
  lines.push(`通过团队间接获得该角色的用户：${result.inheritedUsers.length} 人`)
  if (result.inheritedUsers.length) {
    lines.push(formatTable(
      result.inheritedUsers.slice(0, 20).map((user) => ({ 姓名: user.fullname, 账号: user.domainname ?? '—' })),
      ['姓名', '账号'],
      { width: 44 },
    ))
    if (result.inheritedUsers.length > 20) lines.push(`… 其余 ${result.inheritedUsers.length - 20} 人见完整结果`)
  }
  lines.push('')
  lines.push('「直接拥有」和「通过团队」要分开看：只数 direct 会漏掉团队继承的人，只数两者之并会让「为什么他能看到」失去线索。')
  return lines.join('\n')
}

function renderUserRoles(result) {
  const lines = [`用户：${result.user.fullname}（${result.user.domainname ?? '无域名'}）${result.user.isdisabled ? '（已停用）' : ''}`]
  lines.push(`直接分配的角色：${result.direct.length} 个`)
  if (result.direct.length) {
    lines.push(formatTable(result.direct.map((item) => ({ 角色: item.label })), ['角色'], { width: 60 }))
  }
  lines.push('')
  lines.push(`通过团队继承的角色：${result.inherited.length} 个`)
  if (result.inherited.length) {
    lines.push(formatTable(
      result.inherited.map((item) => ({ 角色: item.label, 来自团队: item.via })),
      ['角色', '来自团队'],
      { width: 44 },
    ))
  }
  return lines.join('\n')
}

function renderPrivileges(result) {
  const lines = [`角色：${result.label}`, `权限：${result.total} 项${result.rows.length !== result.total ? `（已按表过滤，命中 ${result.tables.length} 张表）` : ''}`]
  lines.push('深度：本人 = 只有自己拥有的记录；本部门 = 本业务部门；本部门及下级 = 本级与下级业务部门；组织 = 整个环境。空白表示没有这项权限。')
  lines.push('')
  lines.push(formatTable(
    result.tables.map((table) => ({
      表: table.entity,
      ...Object.fromEntries(RIGHTS.map((right) => [right, table.cells[right] ?? ''])),
    })),
    ['表', ...RIGHTS],
    { width: 28, limit: 40 },
  ))
  if (result.tables.length > 40) lines.push(`… 其余 ${result.tables.length - 40} 张表见完整结果`)
  lines.push('')
  lines.push('要加/减某一条时用它的权限名：`role-privileges` 的完整结果里每条都带 `privilege` 字段（例如 prvWriteAccount）。')
  return lines.join('\n')
}

function renderPlan(plan) {
  const lines = [`计划已生成：${plan.id}`, `环境：${plan.envKey}（${plan.envUrl}）`, `角色：${plan.role.label}`]
  lines.push(`操作：${plan.operations.length} 条${plan.skipped?.length ? `，跳过 ${plan.skipped.length} 条` : ''}`)
  for (const operation of plan.operations) lines.push(`- ${operation.summary}`)
  for (const skip of plan.skipped ?? []) lines.push(`= 跳过：${skip.reason}`)
  if (!plan.operations.length) {
    lines.push('')
    lines.push('没有需要执行的操作，计划可以直接取消。')
    return lines.join('\n')
  }
  lines.push('')
  lines.push('这一步没有写入任何东西。可以说「执行这个计划」，我会弹出确认卡片。')
  return lines.join('\n')
}

function renderConfirmation(plan) {
  const lines = [`环境：${plan.envKey}（${plan.envUrl}）`, `角色：${plan.role.label}`, `操作：${plan.operations.length} 条`]
  for (const operation of plan.operations.slice(0, 10)) lines.push(`- ${operation.summary}`)
  if (plan.operations.length > 10) lines.push(`… 其余 ${plan.operations.length - 10} 条`)
  lines.push('', '这是权限变更：改完立刻对新请求生效。确认后写入，没有撤销键。')
  return lines.join('\n')
}

function renderExecuted(plan, result) {
  const lines = [`已执行计划 ${plan.id}：成功 ${result.results.length} 条，失败 ${result.failures.length} 条。`]
  for (const failure of result.failures) lines.push(`! ${failure.operation?.summary ?? ''}：${failure.error}`)
  if (result.ledger) lines.push(`变更记录：${result.ledger}`)
  lines.push('权限变更通常几秒内对新请求生效；安全角色缓存较顽固时，重新登录该用户即可。')
  return lines.join('\n')
}

function renderPlanRow(plan) {
  const target = plan.role?.label ?? plan.role?.name ?? ''
  const what = plan.operations?.length ? `${plan.operations.length} 条操作` : '无可执行操作'
  return `${plan.id} | ${plan.status} | ${plan.envKey} | ${target} | ${what}`
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args, exec) {
      const config = await loadConfig(state.rawConfig)
      const action = String(args.action ?? '').trim()
      if (!ACTIONS.includes(action)) {
        throw new D365Error(`不认识的操作：${action}`, { code: 'unknown-action', hint: `可选：${ACTIONS.join(' / ')}` })
      }

      if (action === 'list') {
        const plans = (await listPlans(config)).filter((plan) => plan.kind === 'access')
        if (!plans.length) return { text: '没有待确认的权限变更计划。' }
        return { text: ['待确认的权限变更计划：', ...plans.map(renderPlanRow)].join('\n') }
      }

      if (action === 'cancel') {
        const id = String(args.planId ?? '').trim()
        if (!id) throw new D365Error('cancel 需要 planId', { code: 'missing-plan-id' })
        const plan = (await listPlans(config)).find((item) => item.id === id)
        if (!plan || plan.kind !== 'access') throw new D365Error(`没有找到权限变更计划 ${id}`, { code: 'plan-not-found' })
        const removed = await deletePlan(config, id)
        return { text: removed ? `已取消计划 ${id}。` : `没有找到计划 ${id}。` }
      }

      if (action === 'show') {
        const id = String(args.planId ?? '').trim()
        const plan = (await listPlans(config)).find((item) => item.id === id)
        if (!plan || plan.kind !== 'access') throw new D365Error(`没有找到权限变更计划 ${id}`, { code: 'plan-not-found' })
        return { text: renderPlan(plan) }
      }

      if (action === 'execute') {
        const id = String(args.planId ?? '').trim()
        if (!id) throw new D365Error('execute 需要 planId', { hint: '先用 list 查看待确认的计划' })
        const plan = (await listPlans(config)).find((item) => item.id === id)
        if (!plan || plan.kind !== 'access') throw new D365Error(`没有找到权限变更计划 ${id}`, { code: 'plan-not-found' })
        if (plan.status !== 'pending') {
          throw new D365Error(`计划 ${plan.id} 不是待执行状态（${plan.status}）`, {
            code: 'plan-not-pending',
            hint: '先看 .d365/changes 里的执行记录；要再做一次就重新生成计划，不要在原计划上重跑。',
          })
        }
        if (!plan.operations.length) throw new D365Error('这个计划没有可执行的操作', { code: 'empty-plan', hint: '用 cancel 关掉它。' })

        const policy = await readPolicy(config)
        if (!allows(policy, plan.envKey, ACCESS_CAPABILITY)) {
          throw new D365Error(`环境 ${plan.envKey} 未授权改安全角色`, {
            code: 'role-admin-forbidden',
            hint: '在设置页「D365 工具箱 → 权限」里给该环境勾上「改安全角色」后再试；这是高危能力，默认关闭。',
          })
        }

        const userQuestions = ctx.get('userQuestions')
        if (!userQuestions?.ask) throw new D365Error('当前会话没有可用的确认界面', { hint: '请在主对话里执行；没有确认界面时脚本不会写入。' })
        if (!exec?.agent) throw new D365Error('execute 需要可交互的会话', { code: 'needs-agent' })

        const answer = await userQuestions.ask({
          questions: [{
            id: CONFIRM_ID,
            header: `确认修改 ${plan.envKey}`,
            question: `要在 ${plan.envKey} 执行这 ${plan.operations.length} 项权限变更吗？`,
            detail: renderConfirmation(plan),
            options: [
              { label: APPROVE, description: '立即写入该环境，几秒内对新请求生效' },
              { label: CANCEL, description: '不执行，计划继续留在待确认列表' },
            ],
          }],
          agent: exec.agent,
          ...(exec.signal ? { signal: exec.signal } : {}),
          wait: { callId: exec.callId },
        })
        const chosen = answer?.answers?.find((item) => item.id === CONFIRM_ID)?.selected?.[0]
        if (chosen !== APPROVE) return { text: `未执行。计划 ${plan.id} 仍保留在待确认列表里。` }

        const result = await executeAccessPlan(config, plan, exec.signal)
        await deletePlan(config, plan.id)
        return { text: renderExecuted(plan, result) }
      }

      const envKey = String(args.environment ?? config.defaultEnvironment ?? '').trim()
      if (!envKey) throw new D365Error('需要 environment', { hint: `可用：${Object.keys(config.environments).join(', ')}` })
      const env = config.environments[envKey]
      if (!env) throw new D365Error(`未知环境 ${envKey}`, { code: 'unknown-environment', hint: `可用：${Object.keys(config.environments).join(', ')}` })
      const client = (await import('./runtime.js')).makeClient(env, config)

      if (action === 'roles') {
        return { text: renderRoles(await listRoles(client, args, exec?.signal)) }
      }
      if (action === 'who-has-role') {
        if (!args.role) throw new D365Error('who-has-role 需要 role', { code: 'missing-role' })
        return { text: renderWhoHas(await whoHasRole(client, args, exec?.signal)) }
      }
      if (action === 'user-roles') {
        return { text: renderUserRoles(await userRoles(client, args, exec?.signal)) }
      }
      if (action === 'role-privileges') {
        if (!args.role) throw new D365Error('role-privileges 需要 role', { code: 'missing-role' })
        return { text: renderPrivileges(await rolePrivileges(client, args, exec?.signal)) }
      }

      const plan = action === 'plan-add-privileges' || action === 'plan-remove-privileges'
        ? await planPrivileges(config, envKey, { ...args, action }, exec?.signal)
        : await planRoleMembership(config, envKey, { ...args, action }, exec?.signal)

      const saved = await saveAccessPlan(config, { ...plan, rationale: args.rationale })
      return { text: renderPlan(saved) }
    },
  })
}
