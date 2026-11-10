/**
 * `d365_flows` — look at Power Automate cloud flows from Dataverse.
 *
 * Cloud flows are rows of the `workflow` table with `category = 5` (the same
 * table that holds classic workflows, actions and business rules), so no new
 * endpoint or credential is involved. What is *not* readable from the row is
 * the shape of the flow: `primaryentity` is `none`, because a flow is not bound
 * to one table — the tables live inside `clientdata`, the flow definition JSON.
 *
 * This tool parses that JSON into the three answers people actually ask for:
 *
 *   list   which flows exist here, and are they on
 *   show   what one flow does — trigger, steps, connectors, tables
 *   refs   which flows touch this table
 *
 * The definition can be hundreds of kilobytes, so it goes to an artifact; the
 * conversation gets the skeleton. Run history is *not* here: it lives in the
 * Power Automate service, not in Dataverse.
 */
import { loadConfig } from './config.js'
import { formatTable, makeClient, pickEnvironments, writeArtifact } from './runtime.js'
import { D365Error } from './errors.js'

const ACTIONS = ['list', 'show', 'refs']
const MODERN_FLOW_CATEGORY = 5

// Trigger `message` values, from the Dataverse trigger's own picklist.
const TRIGGER_MESSAGES = {
  1: '创建',
  2: '删除',
  3: '更新',
  4: '创建或更新',
  5: '创建或删除',
  6: '更新或删除',
  7: '创建、更新或删除',
}

// Trigger `scope` values: where in the business unit tree the flow listens.
const TRIGGER_SCOPES = {
  1: '用户',
  2: '业务部门',
  3: '业务部门及子部门',
  4: '组织',
}

// Connector ids are `shared_xxx`; a few appear often enough to name.
const CONNECTOR_NAMES = {
  shared_commondataserviceforapps: 'Dataverse',
  shared_commondataservice: 'Dataverse（旧）',
  shared_office365: 'Office 365 Outlook',
  shared_office365users: 'Office 365 用户',
  shared_sharepointonline: 'SharePoint',
  shared_teams: 'Teams',
  shared_approvals: '审批',
  shared_azuread: 'Entra ID',
  shared_powerappsforappmakers: 'Power Apps',
  shared_http: 'HTTP',
  shared_sql: 'SQL Server',
  shared_logicapps: 'Logic Apps',
  shared_onedriveforbusiness: 'OneDrive',
  shared_excelonlinebusiness: 'Excel',
  shared_azureautomation: 'Azure Automation',
}

const definition = {
  name: 'd365_flows',
  title: 'D365 cloud flows',
  description:
    '查询 Power Automate 云流（Dataverse 里 category=5 的 workflow 行）：目录、单条流程的骨架（触发器 / 步骤 / 连接器 / 涉及的表）、以及按表反查哪些流程会碰它。只读，走 Dataverse 现有认证。运行历史不在 Dataverse 里，这个工具查不到。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'list 目录；show 一条流程的骨架；refs 哪些流程碰某张表。',
      },
      name: {
        type: 'string',
        description: 'action=show：流程名称（精确匹配，先 list 拿到）。',
      },
      flowId: {
        type: 'string',
        description: 'action=show：workflowid（GUID），名称有重名或含特殊字符时用它。',
      },
      entity: {
        type: 'string',
        description: 'action=refs：表逻辑名（如 account、contoso_determinationlogictable）。',
      },
      filter: {
        type: 'string',
        description: 'action=list：附加 OData $filter，例如 "statecode eq 1" 只看已开启的。',
      },
      top: {
        type: 'number',
        description: 'action=list 返回多少行（默认 50，最多 500）。',
      },
      scanLimit: {
        type: 'number',
        description: 'action=refs 最多扫描多少条流程（默认 1000，最多 2000）。流程多时会逐页读 clientdata。',
      },
      environment: {
        type: 'string',
        description: '环境 key，省略则用默认环境。',
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

const quote = (value) => String(value ?? '').replace(/'/g, "''")

/**
 * Entity names as they appear in a definition: the Dataverse connector uses
 * the entity *set* name (`accounts`), people type the logical name (`account`).
 * Matching has to accept both without mangling names that end in `s`.
 */
function entityVariants(name) {
  const base = String(name ?? '').trim().toLowerCase()
  const variants = new Set([base])
  if (!base) return variants
  if (base.endsWith('ies')) variants.add(`${base.slice(0, -3)}y`)
  else if (/(ses|xes|ches|shes)$/.test(base)) variants.add(base.slice(0, -2))
  else if (base.endsWith('s') && !base.endsWith('ss')) variants.add(base.slice(0, -1))
  else if (base.endsWith('y')) variants.add(`${base.slice(0, -1)}ies`)
  else variants.add(`${base}s`)
  return variants
}

function sameEntity(a, b) {
  const left = entityVariants(a)
  for (const value of entityVariants(b)) {
    if (left.has(value)) return true
  }
  return false
}

/**
 * Every `entityName`-ish value under the parameters, at any depth.
 *
 * The connector nests them (`parameters.entityName`, `subscriptionRequest/entityname`,
 * `item/entityName` inside a record), and the key spelling differs between the
 * current and the legacy Dataverse connector, so walk instead of guessing.
 */
function entityNamesFrom(parameters) {
  const found = new Set()
  const walk = (value, key) => {
    if (typeof value === 'string') {
      const name = String(key ?? '').toLowerCase()
      if (name.includes('entityname') || name === 'entity') found.add(value.trim().toLowerCase())
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key)
      return
    }
    if (value && typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value)) walk(childValue, childKey)
    }
  }
  walk(parameters, '')
  return [...found]
}

function connectorName(host) {
  const raw = String(host?.connectionName ?? host?.apiId ?? '').trim()
  if (!raw) return ''
  const id = raw.split('/').pop()
  return CONNECTOR_NAMES[id] ?? id
}

/** Parse `clientdata` into its definition and connection references. */
function parseClientData(raw) {
  if (!raw) return undefined
  let data = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return undefined
    try {
      data = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  // Exports wrap the definition in `properties`; a hand-edited row may not.
  const properties = data?.properties ?? data
  return {
    definition: properties?.definition ?? {},
    connectionReferences: properties?.connectionReferences ?? {},
    parameters: properties?.parameters ?? {},
  }
}

function describeTrigger(parsed) {
  const entries = Object.entries(parsed?.definition?.triggers ?? {})
  const [name, trigger] = entries[0] ?? []
  if (!trigger) return { name: '—', kind: '没有触发器', entities: [], operation: '', detail: '' }
  const type = trigger.type ?? '—'
  const host = trigger.inputs?.host ?? {}
  const parameters = trigger.inputs?.parameters ?? {}
  const entities = entityNamesFrom(parameters)
  const operation = host.operationId ?? ''

  if (type === 'Recurrence') {
    const recurrence = trigger.recurrence ?? {}
    const every = [recurrence.frequency, recurrence.interval ? `每 ${recurrence.interval} 次` : '']
      .filter(Boolean)
      .join(' ')
    return { name, kind: `计划（${every || '未写频率'}）`, entities, operation: 'Recurrence', detail: recurrence.startTime ?? '' }
  }
  if (type === 'Request') {
    return { name, kind: `手动 / HTTP（${trigger.kind ?? 'Http'}）`, entities, operation: 'Request', detail: '' }
  }

  // Event triggers (Dataverse, SharePoint, …) carry their binding in
  // `subscriptionRequest/…` flattened keys.
  const message = Number(parameters['subscriptionRequest/message'] ?? parameters.message)
  const scope = Number(parameters['subscriptionRequest/scope'] ?? parameters.scope)
  const filterAttributes = parameters['subscriptionRequest/filteringattributes']
  const detail = [
    TRIGGER_MESSAGES[message] ? `当记录${TRIGGER_MESSAGES[message]}` : '',
    TRIGGER_SCOPES[scope] ? `范围：${TRIGGER_SCOPES[scope]}` : '',
    filterAttributes ? `过滤列：${filterAttributes}` : '',
  ]
    .filter(Boolean)
    .join('，')
  const connector = connectorName(host)
  return {
    name,
    kind: `${connector || '连接器'}：${operation || type}`,
    entities,
    operation,
    connector,
    detail,
  }
}

function describeAction(action) {
  const type = action?.type ?? '—'
  const host = action?.inputs?.host ?? {}
  const parameters = action?.inputs?.parameters ?? {}
  const operation = host.operationId ?? action?.inputs?.operationId ?? ''
  const connector = connectorName(host)
  const entities = entityNamesFrom(parameters)

  let detail = ''
  if (type === 'Terminate') {
    const status = action?.inputs?.runStatus ?? ''
    const message = action?.inputs?.runError?.message ?? ''
    detail = [status, message].filter(Boolean).join('：')
  } else if (type === 'Http' || type === 'OpenApiConnection' || type === 'ApiConnection') {
    const uri = action?.inputs?.uri ?? parameters.uri ?? ''
    if (uri) detail = `URL：${String(uri).slice(0, 160)}`
  } else if (type === 'Compose') {
    const input = action?.inputs
    if (typeof input === 'string') detail = input.slice(0, 120)
  } else if (type === 'Workflow' || operation === 'RunAChildFlow') {
    detail = host.workflowReferenceName ? `子流程：${host.workflowReferenceName}` : '调用子流程'
  } else if (parameters.recordId || parameters.item) {
    detail = '按记录 id / 记录对象操作'
  }

  return { type, operation, connector, entities, detail }
}

/**
 * Flatten the action tree, including the branches that are easy to forget:
 * `else`, `cases` (switch) and the actions inside `foreach` / `until` / `scope`.
 */
function flattenActions(actions, prefix = '', out = []) {
  for (const [name, action] of Object.entries(actions ?? {})) {
    const path = prefix ? `${prefix} > ${name}` : name
    out.push({ path, ...describeAction(action) })
    if (action?.actions) flattenActions(action.actions, path, out)
    if (action?.else?.actions) flattenActions(action.else.actions, `${path}（否则）`, out)
    for (const [caseName, branch] of Object.entries(action?.cases ?? {})) {
      if (branch?.actions) flattenActions(branch.actions, `${path}（${caseName}）`, out)
    }
  }
  return out
}

function summarizeFlow(row) {
  const parsed = parseClientData(row.clientdata)
  if (!parsed) return undefined
  const trigger = describeTrigger(parsed)
  const steps = flattenActions(parsed.definition?.actions)
  const entities = new Set([...trigger.entities, ...steps.flatMap((step) => step.entities)])
  const connectors = new Set()
  if (trigger.connector) connectors.add(trigger.connector)
  for (const step of steps) if (step.connector) connectors.add(step.connector)
  return {
    trigger,
    steps,
    entities: [...entities],
    connectors: [...connectors],
    connectionReferences: Object.keys(parsed.connectionReferences ?? {}),
  }
}

function shortTime(value) {
  const text = String(value ?? '')
  return text.length >= 19 ? text.slice(0, 19).replace('T', ' ') : text || '—'
}

/**
 * Resolve owner ids to display names.
 *
 * `$expand=ownerid($select=fullname)` on `workflow` is refused by the server
 * (the lookup is polymorphic), so the ids are batched into a user query and a
 * team query instead: two requests for a whole page.
 */
async function resolveOwnerNames(client, ids, signal) {
  const names = new Map()
  const unique = [...new Set(ids.filter(Boolean))]
  for (let index = 0; index < unique.length; index += 20) {
    const chunk = unique.slice(index, index + 20)
    const filter = chunk.map((id) => `systemuserid eq ${id}`).join(' or ')
    try {
      const page = await client.getPaged('systemusers', {
        $select: 'systemuserid,fullname',
        $filter: filter,
        __noTop: true,
      }, chunk.length, signal)
      for (const row of page.records ?? []) names.set(row.systemuserid, row.fullname)
    } catch {
      // Fall through to teams; an unreadable owner is cosmetic.
    }
    const teamFilter = chunk.map((id) => `teamid eq ${id}`).join(' or ')
    try {
      const page = await client.getPaged('teams', {
        $select: 'teamid,name',
        $filter: teamFilter,
        __noTop: true,
      }, chunk.length, signal)
      for (const row of page.records ?? []) names.set(row.teamid, row.name)
    } catch {
      // Same.
    }
  }
  return names
}

function stateLabel(statecode) {
  const value = Number(statecode)
  if (value === 1) return '开启'
  if (value === 0) return '关闭'
  return Number.isFinite(value) ? `statecode ${value}` : '—'
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args, exec) {
      const config = await loadConfig(state.rawConfig)
      const action = args.action
      if (!ACTIONS.includes(action)) {
        throw new D365Error(`不认识的操作：${action}`, { code: 'unknown-action', hint: `可选：${ACTIONS.join(' / ')}` })
      }
      if (action === 'refs' && !String(args.entity ?? '').trim()) {
        throw new D365Error('action=refs 需要 entity', {
          code: 'missing-entity',
          hint: '传表的逻辑名，例如 {"action":"refs","entity":"account"}。',
        })
      }
      if (action === 'show' && !String(args.flowId ?? '').trim() && !String(args.name ?? '').trim()) {
        throw new D365Error('action=show 需要 name 或 flowId', {
          code: 'missing-flow',
          hint: '先跑 action=list，把流程名或 workflowid 传进来。',
        })
      }

      const envs = pickEnvironments(config, args)
      const reports = []
      const artifact = { action, environments: {} }

      for (const env of envs) {
        const client = makeClient(env, config)

        if (action === 'list') {
          const top = Number.isFinite(args.top) ? Math.max(1, Math.min(500, args.top)) : 50
          const parts = [`category eq ${MODERN_FLOW_CATEGORY}`]
          if (String(args.filter ?? '').trim()) parts.push(`(${String(args.filter).trim()})`)
          const base = {
            $select: 'workflowid,name,statecode,statuscode,ismanaged,modifiedon,type,_ownerid_value',
            $filter: parts.join(' and '),
            $orderby: 'modifiedon desc',
          }
          const page = await client.getPaged('workflows', base, top, exec?.signal)
          const rows = page.records ?? []
          const owners = await resolveOwnerNames(client, rows.map((row) => row._ownerid_value), exec?.signal)
          artifact.environments[env.key] = { rows, hasMore: page.hasMore, filter: base.$filter }
          const table = rows.length
            ? formatTable(rows.map((row) => ({
              name: row.name ?? '—',
              state: stateLabel(row.statecode),
              managed: row.ismanaged ? '是' : '否',
              owner: owners.get(row._ownerid_value) ?? (row._ownerid_value ? `${String(row._ownerid_value).slice(0, 8)}…` : '—'),
              modified: shortTime(row.modifiedon),
            })), ['name', 'state', 'owner', 'modified'], { width: 46 })
            : '（这个环境没有匹配的云流）'
          const head = rows.length
            ? `${env.key}：已列 ${rows.length} 条云流${page.hasMore ? '（已达上限，用 filter 或 top 缩小）' : ''}`
            : `${env.key}：没有匹配的云流`
          reports.push([head, table].join('\n'))
          continue
        }

        if (action === 'show') {
          const parts = [`category eq ${MODERN_FLOW_CATEGORY}`]
          if (String(args.flowId ?? '').trim()) parts.push(`workflowid eq ${String(args.flowId).trim()}`)
          else parts.push(`name eq '${quote(args.name)}'`)
          const page = await client.getPaged('workflows', {
            $select: 'workflowid,name,statecode,statuscode,ismanaged,modifiedon,createdon,type,clientdata',
            $filter: parts.join(' and '),
          }, 1, exec?.signal)
          const row = (page.records ?? [])[0]
          if (!row) {
            throw new D365Error(`${env.key} 里找不到这条云流`, {
              code: 'flow-not-found',
              hint: '用 action=list 确认名称（精确匹配，含空格与括号），或改用 flowId。',
            })
          }
          const summary = summarizeFlow(row)
          if (!summary) {
            throw new D365Error(`「${row.name}」的 clientdata 不是可解析的流程定义`, {
              code: 'bad-definition',
              hint: '这条记录可能是被停用或迁移失败留下的空壳；先看它的 updated 时间与 owner。',
            })
          }
          artifact.environments[env.key] = { row: { ...row, clientdata: undefined }, summary }
          const lines = [
            `${env.key}：流程「${row.name}」`,
            `- 状态：${stateLabel(row.statecode)}（statecode ${row.statecode ?? '—'}）`,
            `- 托管：${row.ismanaged ? '是' : '否'}，修改于 ${shortTime(row.modifiedon)}`,
            `- 触发器：${summary.trigger.kind}${summary.trigger.detail ? `（${summary.trigger.detail}）` : ''}`,
            `- 动作：${summary.steps.length} 个`,
            `- 涉及的表：${summary.entities.length ? summary.entities.join('、') : '（没有明确写出表名）'}`,
            `- 连接器：${summary.connectors.length ? summary.connectors.join('、') : '—'}`,
          ]
          if (summary.connectionReferences.length) {
            lines.push(`- 连接引用：${summary.connectionReferences.join('、')}`)
          }
          const steps = summary.steps.length
            ? formatTable(summary.steps.slice(0, 40).map((step) => ({
              step: step.path,
              type: step.type,
              'connector/operation': [step.connector, step.operation].filter(Boolean).join(' / ') || '—',
              entity: step.entities.join('、') || '—',
              detail: step.detail || '—',
            })), ['step', 'type', 'connector/operation', 'entity'], { width: 40 })
            : '（没有动作，只有触发器）'
          if (summary.steps.length > 40) {
            lines.push(`（只列了前 40 个动作，其余 ${summary.steps.length - 40} 个见完整结果）`)
          }
          reports.push([...lines, '', steps].join('\n'))
          continue
        }

        // refs: the definition is a memo column with no server-side query, so
        // every flow has to be read and scanned locally. `$top` must be left to
        // `getPaged` — Dataverse treats an explicit `$top` as the total, returns
        // exactly that many rows and no `@odata.nextLink`, which makes a capped
        // scan look complete.
        const scanLimit = Number.isFinite(args.scanLimit) ? Math.max(1, Math.min(2000, args.scanLimit)) : 1000
        const page = await client.getPaged('workflows', {
          $select: 'workflowid,name,statecode,clientdata',
          $filter: `category eq ${MODERN_FLOW_CATEGORY}`,
          $orderby: 'name asc',
        }, scanLimit, exec?.signal)
        const rows = page.records ?? []
        const hits = []
        let parsedCount = 0
        for (const row of rows) {
          const parsed = parseClientData(row.clientdata)
          if (!parsed) continue
          parsedCount += 1
          const trigger = describeTrigger(parsed)
          if (trigger.entities.some((name) => sameEntity(name, args.entity))) {
            hits.push({
              flow: row.name,
              state: stateLabel(row.statecode),
              where: `触发器：${trigger.name}`,
              operation: trigger.operation || trigger.kind,
              entity: trigger.entities.join('、'),
            })
          }
          for (const step of flattenActions(parsed.definition?.actions)) {
            if (!step.entities.some((name) => sameEntity(name, args.entity))) continue
            hits.push({
              flow: row.name,
              state: stateLabel(row.statecode),
              where: `动作：${step.path}`,
              operation: [step.connector, step.operation].filter(Boolean).join(' / ') || step.type,
              entity: step.entities.join('、'),
            })
          }
        }
        artifact.environments[env.key] = {
          entity: args.entity,
          scanned: rows.length,
          parsed: parsedCount,
          hasMore: page.hasMore,
          hits,
        }
        const flows = new Set(hits.map((hit) => hit.flow))
        const head = hits.length
          ? `${env.key}：${flows.size} 条云流会碰 ${args.entity}（扫描 ${parsedCount}/${rows.length} 条${page.hasMore ? `，已达 scanLimit ${scanLimit}` : ''}）`
          : `${env.key}：扫描 ${parsedCount} 条云流，没有碰 ${args.entity} 的${page.hasMore ? `（只扫了前 ${scanLimit} 条）` : ''}`
        const table = hits.length
          ? formatTable(hits.map((hit) => ({
            flow: hit.flow,
            state: hit.state,
            where: hit.where,
            'operation': hit.operation,
          })), ['flow', 'state', 'where', 'operation'], { width: 44 })
          : ''
        reports.push([head, table].filter(Boolean).join('\n'))
      }

      const file = await writeArtifact(config, `flows-${action}`, artifact)
      return { text: `${reports.join('\n\n')}\n\n完整结果：${file}` }
    },
  })
}
