/**
 * `d365_roles` — who holds which security role, what a role may do, and the
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
import { t } from './i18n.js'

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

const APPROVE = () => t('access.approve')
const CANCEL = () => t('access.cancel')
const CONFIRM_ID = 'd365-access-confirm'

const RIGHTS = ['create', 'read', 'write', 'delete', 'append', 'appendTo', 'assign', 'share']

export const definition = {
  name: 'd365_roles',
  description:
    'Inspect and change Dataverse security roles: membership, direct and team-inherited assignments, and table privileges at user, business-unit, hierarchy, or organization depth. '
    + 'plan-* actions only create plans; execute requires human confirmation in chat before writing. '
    + 'Reads require data.read; writes require role.admin (disabled by default). Role names repeat by business unit, so writes require a unique role record. '
    + 'Use d365_metadata_write for metadata and d365_data_write for business records.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description:
          'roles lists role records; who-has-role/user-roles/role-privileges are read-only. '
          + 'plan-assign-role, plan-remove-role, plan-add-privileges, and plan-remove-privileges create plans; '
          + 'list/show/cancel manage plans; execute requires human approval.',
      },
      environment: { type: 'string', description: 'Environment key such as dev; defaults to the configured environment.' },
      role: { type: 'string', description: 'Role name or roleid. Names repeat by business unit; use businessunit or roleid to select uniquely.' },
      businessunit: { type: 'string', description: 'Business-unit name or GUID; pins duplicate role names to one unit, such as AP.' },
      user: { type: 'string', description: 'User GUID, domain account (user@contoso.com), or name. Queries allow fuzzy matching; writes require a unique match.' },
      team: { type: 'string', description: 'Team GUID or name. When supplied, team takes precedence over user.' },
      entity: { type: 'string', description: 'For role-privileges: table logical name to inspect, such as account.' },
      privileges: {
        type: 'array',
        description: 'For plan-add/remove-privileges: "prvWriteAccount" or {name,depth}; obtain names from role-privileges.',
        items: {
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                depth: { type: 'string', description: 'basic (user), local (business unit), deep (unit and descendants), or global (organization). Omitted: additions use existing depth or global; removals ignore depth.' },
              },
              required: ['name'],
            },
          ],
        },
      },
      name: { type: 'string', description: 'For roles: contains-match by name, equivalent to contains(name,...).' },
      filter: { type: 'string', description: "For roles: additional OData $filter, for example contains(name,'Sales')." },
      top: { type: 'integer', description: 'For roles: maximum role rows, default 200, maximum 1000.' },
      planId: { type: 'string', description: 'For show/cancel/execute: target plan id.' },
      rationale: { type: 'string', description: 'Reason for the change, recorded in the plan and change ledger.' },
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
  const lines = [t('access.roles.heading',{names:result.groups.length,rows:result.rows.length})]
  lines.push(t('access.roles.note'), '')
  lines.push(formatTable(result.groups.map((group) => ({
    [t('access.col.name')]: group.name,
    [t('access.col.copies')]: group.total,
    [t('access.col.managed')]: group.managed,
    [t('access.col.businessUnits')]: group.units.slice(0, 6).join(', ') + (group.units.length > 6 ? t('access.more.units',{count:group.units.length}) : ''),
  })), [t('access.col.name'),t('access.col.copies'),t('access.col.managed'),t('access.col.businessUnits')], { width: 48 }))
  return lines.join('\n')
}

function renderWhoHas(result) {
  const lines = [t('access.role.heading',{label:result.label}), t('access.directUsers',{count:result.directUsers.length})]
  const enabled = result.directUsers.filter((user) => !user.isdisabled)
  if (enabled.length) {
    lines.push(formatTable(enabled.slice(0,30).map((user)=>({[t('access.col.name')]:user.fullname,[t('access.col.account')]:user.domainname??'—'})),[t('access.col.name'),t('access.col.account')],{width:44}))
    if(enabled.length>30) lines.push(t('access.more.users',{count:enabled.length-30}))
  }
  lines.push('',t('access.teams.count',{count:result.teams.length}))
  if(result.teams.length) lines.push(formatTable(result.teams.map((team)=>({[t('access.col.team')]:team.name,[t('access.col.type')]:team.teamtype===2?t('access.team.owner'):t('access.team.access'),[t('access.col.members')]:team.memberCount})),[t('access.col.team'),t('access.col.type'),t('access.col.members')],{width:44}))
  lines.push('',t('access.inheritedUsers',{count:result.inheritedUsers.length}))
  if(result.inheritedUsers.length){lines.push(formatTable(result.inheritedUsers.slice(0,20).map((user)=>({[t('access.col.name')]:user.fullname,[t('access.col.account')]:user.domainname??'—'})),[t('access.col.name'),t('access.col.account')],{width:44}));if(result.inheritedUsers.length>20)lines.push(t('access.more.users',{count:result.inheritedUsers.length-20}))}
  lines.push('',t('access.directVsTeam'))
  return lines.join('\n')
}

function renderUserRoles(result){
  const lines=[t('access.user.heading',{name:result.user.fullname,domain:result.user.domainname??t('access.noDomain'),disabled:result.user.isdisabled?t('access.disabled'):''})]
  lines.push(t('access.directRoles',{count:result.direct.length}))
  if(result.direct.length)lines.push(formatTable(result.direct.map((item)=>({[t('access.col.role')]:item.label})),[t('access.col.role')],{width:60}))
  lines.push('',t('access.inheritedRoles',{count:result.inherited.length}))
  if(result.inherited.length)lines.push(formatTable(result.inherited.map((item)=>({[t('access.col.role')]:item.label,[t('access.col.viaTeam')]:item.via})),[t('access.col.role'),t('access.col.viaTeam')],{width:44}))
  return lines.join('\n')
}

function renderPrivileges(result){
  const labels={create:t('access.right.create'),read:t('access.right.read'),write:t('access.right.write'),delete:t('access.right.delete'),append:t('access.right.append'),appendTo:t('access.right.appendTo'),assign:t('access.right.assign'),share:t('access.right.share')}
  const headers=RIGHTS.map((right)=>labels[right])
  const lines=[t('access.role.heading',{label:result.label}),t('access.privileges.heading',{total:result.total,filter:result.rows.length!==result.total?t('access.filtered',{tables:result.tables.length}):''})]
  lines.push(t('access.depthHelp'),'')
  lines.push(formatTable(result.tables.map((table)=>({[t('access.col.table')]:table.entity,...Object.fromEntries(RIGHTS.map((right)=>[labels[right],table.cells[right]??'']))})),[t('access.col.table'),...headers],{width:28,limit:40}))
  if(result.tables.length>40)lines.push(t('access.more.tables',{count:result.tables.length-40}))
  lines.push('',t('access.privilegeNameHelp'))
  return lines.join('\n')
}

function renderPlan(plan){const lines=[t('access.plan.generated',{id:plan.id}),t('access.plan.environment',{key:plan.envKey,url:plan.envUrl}),t('access.plan.role',{label:plan.role.label}),t('access.plan.operations',{count:plan.operations.length,skipped:plan.skipped?.length?t('access.plan.skippedCount',{count:plan.skipped.length}):''})];for(const o of plan.operations)lines.push('- '+o.summary);for(const x of plan.skipped??[])lines.push('= '+t('access.plan.skipped',{reason:x.reason}));if(!plan.operations.length){lines.push('',t('access.plan.empty'));return lines.join('\n')}lines.push('',t('access.plan.readOnly'));return lines.join('\n')}
function renderConfirmation(plan){const lines=[t('access.plan.environment',{key:plan.envKey,url:plan.envUrl}),t('access.plan.role',{label:plan.role.label}),t('access.plan.operations',{count:plan.operations.length,skipped:''})];for(const o of plan.operations.slice(0,10))lines.push('- '+o.summary);if(plan.operations.length>10)lines.push(t('access.more.operations',{count:plan.operations.length-10}));lines.push('',t('access.confirm.warning'));return lines.join('\n')}
function renderExecuted(plan,result){const lines=[t('access.executed',{id:plan.id,success:result.results.length,failed:result.failures.length})];for(const f of result.failures)lines.push('! '+(f.operation?.summary??'')+': '+f.error);if(result.ledger)lines.push(t('access.ledger',{path:result.ledger}));lines.push(t('access.cacheHint'));return lines.join('\n')}
function renderPlanRow(plan){const target=plan.role?.label??plan.role?.name??'';const what=plan.operations?.length?t('access.plan.operationCount',{count:plan.operations.length}):t('access.plan.noOperations');return [plan.id,plan.status,plan.envKey,target,what].join(' | ')}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args, exec) {
      const config = await loadConfig(state.rawConfig)
      const action = String(args.action ?? '').trim()
      if (!ACTIONS.includes(action)) {
        throw new D365Error(t('access.unknownAction',{action}), { code: 'unknown-action', hint: t('access.availableActions',{actions:ACTIONS.join(' / ')}) })
      }

      if (action === 'list') {
        const plans = (await listPlans(config)).filter((plan) => plan.kind === 'access')
        if (!plans.length) return { text: t('access.noPendingPlans') }
        return { text: [t('access.pendingPlans'), ...plans.map(renderPlanRow)].join('\n') }
      }

      if (action === 'cancel') {
        const id = String(args.planId ?? '').trim()
        if (!id) throw new D365Error(t('access.cancelNeedsId'), { code: 'missing-plan-id' })
        const plan = (await listPlans(config)).find((item) => item.id === id)
        if (!plan || plan.kind !== 'access') throw new D365Error(t('access.planMissing',{id}), { code: 'plan-not-found' })
        const removed = await deletePlan(config, id)
        return { text: removed ? t('access.cancelled',{id}) : t('access.idMissing',{id}) }
      }

      if (action === 'show') {
        const id = String(args.planId ?? '').trim()
        const plan = (await listPlans(config)).find((item) => item.id === id)
        if (!plan || plan.kind !== 'access') throw new D365Error(t('access.planMissing',{id}), { code: 'plan-not-found' })
        return { text: renderPlan(plan) }
      }

      if (action === 'execute') {
        const id = String(args.planId ?? '').trim()
        if (!id) throw new D365Error(t('access.executeNeedsId'), { hint: t('access.listHint') })
        const plan = (await listPlans(config)).find((item) => item.id === id)
        if (!plan || plan.kind !== 'access') throw new D365Error(t('access.planMissing',{id}), { code: 'plan-not-found' })
        if (plan.status !== 'pending') {
          throw new D365Error(t('access.notPending',{id:plan.id,status:plan.status}), {
            code: 'plan-not-pending',
            hint: t('access.notPendingHint'),
          })
        }
        if (!plan.operations.length) throw new D365Error(t('access.plan.empty'), { code: 'empty-plan', hint: t('access.cancelEmptyHint') })

        // `readPolicy` takes the config *path*; passing the config object made it
        // read `[object Object]`, fall back to the default grant and report
        // the security-role capability as never granted.
        const policy = await readPolicy(config.configFile)
        if (!allows(policy, plan.envKey, ACCESS_CAPABILITY)) {
          throw new D365Error(t('access.forbidden',{key:plan.envKey}), {
            code: 'role-admin-forbidden',
            hint: t('access.forbiddenHint'),
          })
        }

        const userQuestions = ctx.get('userQuestions')
        if (!userQuestions?.ask) throw new D365Error(t('access.noConfirmation'), { hint: t('access.noUiHint') })
        if (!exec?.agent) throw new D365Error(t('access.interactiveRequired'), { code: 'needs-agent' })

        const answer = await userQuestions.ask({
          questions: [{
            id: CONFIRM_ID,
            header: t('access.confirm.header',{key:plan.envKey}),
            question: t('access.confirm.question',{key:plan.envKey,count:plan.operations.length}),
            detail: renderConfirmation(plan),
            options: [
              { label: APPROVE(), description: t('access.confirm.approve') },
              { label: CANCEL(), description: t('access.confirm.cancel') },
            ],
          }],
          agent: exec.agent,
          ...(exec.signal ? { signal: exec.signal } : {}),
          wait: { callId: exec.callId },
        })
        const chosen = answer?.answers?.find((item) => item.id === CONFIRM_ID)?.selected?.[0]
        if (chosen !== APPROVE()) return { text: t('access.notExecuted',{id:plan.id}) }

        const result = await executeAccessPlan(config, plan, exec.signal)
        // A partly failed plan must stay visible: deleting it would leave the
        // page with nothing to show for the operations that did not land.
        if (!result.failures.length) await deletePlan(config, plan.id)
        return { text: renderExecuted(plan, result) }
      }

      const envKey = String(args.environment ?? config.defaultEnvironment ?? '').trim()
      if (!envKey) throw new D365Error(t('access.environmentRequired'), { hint: t('access.availableEnvironments',{envs:Object.keys(config.environments).join(', ')}) })
      const env = config.environments[envKey]
      if (!env) throw new D365Error(t('access.environmentUnknown',{key:envKey}), { code: 'unknown-environment', hint: t('access.availableEnvironments',{envs:Object.keys(config.environments).join(', ')}) })
      const client = (await import('./runtime.js')).makeClient(env, config)

      if (action === 'roles') {
        return { text: renderRoles(await listRoles(client, args, exec?.signal)) }
      }
      if (action === 'who-has-role') {
        if (!args.role) throw new D365Error(t('access.roleRequired',{action:'who-has-role'}), { code: 'missing-role' })
        return { text: renderWhoHas(await whoHasRole(client, args, exec?.signal)) }
      }
      if (action === 'user-roles') {
        return { text: renderUserRoles(await userRoles(client, args, exec?.signal)) }
      }
      if (action === 'role-privileges') {
        if (!args.role) throw new D365Error(t('access.roleRequired',{action:'role-privileges'}), { code: 'missing-role' })
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
