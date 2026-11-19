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
import { formatTable, makeClient, mapEnvironments, pickEnvironments, writeArtifact } from './runtime.js'
import { D365Error } from './errors.js'
import { t } from './i18n.js'

const ACTIONS = ['list', 'show', 'refs']
const MODERN_FLOW_CATEGORY = 5

// Trigger `message` values, from the Dataverse trigger's own picklist.
const TRIGGER_MESSAGES = {
  1: 'Create',
  2: 'Delete',
  3: 'Update',
  4: 'Create or update',
  5: 'Create or delete',
  6: 'Update or delete',
  7: 'Create, update, or delete',
}

// Trigger `scope` values: where in the business unit tree the flow listens.
const TRIGGER_SCOPES = {
  1: 'User',
  2: 'Business unit',
  3: 'Business unit and children',
  4: 'Organization',
}

// Connector ids are `shared_xxx`; a few appear often enough to name.
const CONNECTOR_NAMES = {
  shared_commondataserviceforapps: 'Dataverse',
  shared_commondataservice: 'Dataverse (legacy)',
  shared_office365: 'Office 365 Outlook',
  shared_office365users: 'Office 365 Users',
  shared_sharepointonline: 'SharePoint',
  shared_teams: 'Teams',
  shared_approvals: 'Approvals',
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
    'Read Power Automate cloud flows stored as Dataverse category=5 workflow rows: catalog, one flow skeleton, or table references. '
    + 'Read-only. Flow run history is not stored in Dataverse.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'list shows the catalog; show shows one flow skeleton; refs finds flows that touch a table.',
      },
      name: {
        type: 'string',
        description: 'For show: exact flow name, first obtained from list.',
      },
      flowId: {
        type: 'string',
        description: 'For show: workflowid GUID; use when names are duplicated or contain special characters.',
      },
      entity: {
        type: 'string',
        description: 'For refs: table logical name, such as account or contoso_determinationlogictable.',
      },
      filter: {
        type: 'string',
        description: 'For list: additional OData $filter, such as "statecode eq 1" for active flows.',
      },
      top: {
        type: 'number',
        description: 'For list: maximum rows, default 50, maximum 500.',
      },
      scanLimit: {
        type: 'number',
        description: 'For refs: maximum flows to scan, default 1000, maximum 2000. clientdata is paged for large catalogs.',
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

/**
 * Parse `clientdata` into its definition and connection references.
 *
 * Dataverse stores three shapes for the same flow:
 *   1. `{ properties: { definition, connectionReferences } }` — exported /
 *      solution-carried flows;
 *   2. `{ definition, connectionReferences }` — rows written by the designer;
 *   3. a bare definition, with `triggers` / `actions` at the top level.
 *
 * Missing shape 3 made those flows render as "no trigger" with zero actions, and
 * the `refs` scan silently skipped every entity they touch.
 */
export function parseClientData(raw) {
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
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  // Unwrap `{properties:{…}}` when it is there; otherwise the object is itself
  // the container.
  const properties = data.properties && typeof data.properties === 'object' ? data.properties : data
  const isDefinition = (value) => Boolean(value) && typeof value === 'object'
    && (value.triggers !== undefined || value.actions !== undefined)
  return {
    definition: isDefinition(properties) && !isDefinition(properties.definition) ? properties : (properties.definition ?? {}),
    connectionReferences: properties.connectionReferences ?? data.connectionReferences ?? {},
    parameters: properties.parameters ?? data.parameters ?? {},
  }
}

function describeTrigger(parsed) {
  const entries = Object.entries(parsed?.definition?.triggers ?? {})
  const [name, trigger] = entries[0] ?? []
  if (!trigger) return { name: '—', kind: t('flows.noTrigger'), entities: [], operation: '', detail: '' }
  const type = trigger.type ?? '—'
  const host = trigger.inputs?.host ?? {}
  const parameters = trigger.inputs?.parameters ?? {}
  const entities = entityNamesFrom(parameters)
  const operation = host.operationId ?? ''

  if (type === 'Recurrence') {
    const recurrence = trigger.recurrence ?? {}
    const every = [recurrence.frequency, recurrence.interval ? t('flows.every', { interval: recurrence.interval }) : '']
      .filter(Boolean)
      .join(' ')
    return { name, kind: t('flows.scheduled', { every: every || t('flows.frequencyMissing') }), entities, operation: 'Recurrence', detail: recurrence.startTime ?? '' }
  }
  if (type === 'Request') {
    return { name, kind: t('flows.manualHttp', { kind: trigger.kind ?? 'Http' }), entities, operation: 'Request', detail: '' }
  }

  // Event triggers (Dataverse, SharePoint, …) carry their binding in
  // `subscriptionRequest/…` flattened keys.
  const message = Number(parameters['subscriptionRequest/message'] ?? parameters.message)
  const scope = Number(parameters['subscriptionRequest/scope'] ?? parameters.scope)
  const filterAttributes = parameters['subscriptionRequest/filteringattributes']
  // `filteringattributes` only says which columns are watched; the actual
  // condition lives in `filterexpression` (`statuscode eq 1 and …`).
  const filterExpression = parameters['subscriptionRequest/filterexpression']
  const detail = [
    TRIGGER_MESSAGES[message] ? t('flows.whenRecord', { message: TRIGGER_MESSAGES[message] }) : '',
    TRIGGER_SCOPES[scope] ? t('flows.scope', { scope: TRIGGER_SCOPES[scope] }) : '',
    filterAttributes ? t('flows.filterColumns', { value: filterAttributes }) : '',
    filterExpression ? t('flows.condition', { value: filterExpression }) : '',
  ]
    .filter(Boolean)
    .join(t('flows.listSeparator'))
  const connector = connectorName(host)
  return {
    name,
    kind: t('flows.connectorOperation', { connector: connector || t('flows.connector'), operation: operation || type }),
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
    detail = [status, message].filter(Boolean).join(': ')
  } else if (type === 'Http' || type === 'OpenApiConnection' || type === 'ApiConnection') {
    const uri = action?.inputs?.uri ?? parameters.uri ?? ''
    if (uri) detail = t('flows.url', { value: String(uri).slice(0, 160) })
  } else if (type === 'Compose') {
    const input = action?.inputs
    if (typeof input === 'string') detail = input.slice(0, 120)
  } else if (type === 'Workflow' || operation === 'RunAChildFlow') {
    detail = host.workflowReferenceName ? t('flows.childFlowNamed', { name: host.workflowReferenceName }) : t('flows.childFlow')
  } else if (parameters.recordId || parameters.item) {
    detail = t('flows.recordOperation')
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
    if (action?.else?.actions) flattenActions(action.else.actions, `${path} (${t('flows.elseBranch')})`, out)
    for (const [caseName, branch] of Object.entries(action?.cases ?? {})) {
      if (branch?.actions) flattenActions(branch.actions, `${path} (${caseName})`, out)
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
  if (value === 1) return t('flows.on')
  if (value === 0) return t('flows.off')
  return Number.isFinite(value) ? `statecode ${value}` : '—'
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args, exec) {
      const config = await loadConfig(state.rawConfig)
      const action = args.action
      if (!ACTIONS.includes(action)) {
        throw new D365Error(t('flows.error.unknownAction', { action }), { code: 'unknown-action', hint: t('flows.hint.actions', { values: ACTIONS.join(' / ') }) })
      }
      if (action === 'refs' && !String(args.entity ?? '').trim()) {
        throw new D365Error(t('flows.error.missingEntity'), {
          code: 'missing-entity',
          hint: t('flows.hint.entity'),
        })
      }
      if (action === 'show' && !String(args.flowId ?? '').trim() && !String(args.name ?? '').trim()) {
        throw new D365Error(t('flows.error.missingFlow'), {
          code: 'missing-flow',
          hint: t('flows.hint.listFirst'),
        })
      }

      const flowId = String(args.flowId ?? '').trim()
      if (flowId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(flowId)) {
        throw new D365Error(t('flows.error.badId', { flowId }), {
          code: 'bad-id',
          hint: t('flows.hint.badId'),
        })
      }

      const envs = pickEnvironments(config, args)
      // Slot per environment: workers finish in any order, the report must not.
      const reports = new Array(envs.length)
      const artifact = { action, environments: {} }

      await mapEnvironments(envs, async (env, index) => {
        try {
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
              managed: row.ismanaged ? t('flows.yes') : t('flows.no'),
              owner: owners.get(row._ownerid_value) ?? (row._ownerid_value ? `${String(row._ownerid_value).slice(0, 8)}…` : '—'),
              modified: shortTime(row.modifiedon),
            })), ['name', 'state', 'owner', 'modified'], { width: 46 })
            : t('flows.emptyCatalog')
          const head = rows.length
            ? t('flows.listHead', { env: env.key, count: rows.length, limited: page.hasMore ? t('flows.listLimited') : '' })
            : t('flows.listEmptyHead', { env: env.key })
          reports[index] = [head, table].join('\n')
          return
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
            throw new D365Error(t('flows.error.notFound', { env: env.key }), {
              code: 'flow-not-found',
              hint: t('flows.hint.notFound'),
            })
          }
          const summary = summarizeFlow(row)
          if (!summary) {
            throw new D365Error(t('flows.error.badDefinition', { name: row.name }), {
              code: 'bad-definition',
              hint: t('flows.hint.badDefinition'),
            })
          }
          artifact.environments[env.key] = { row: { ...row, clientdata: undefined }, summary }
          const lines = [
            t('flows.flowHead', { env: env.key, name: row.name }),
            t('flows.stateLine', { state: stateLabel(row.statecode), code: row.statecode ?? '—' }),
            t('flows.managedLine', { managed: row.ismanaged ? t('flows.yes') : t('flows.no'), time: shortTime(row.modifiedon) }),
            t('flows.triggerLine', { kind: summary.trigger.kind, detail: summary.trigger.detail ? ` (${summary.trigger.detail})` : '' }),
            t('flows.actionsLine', { count: summary.steps.length }),
            t('flows.tablesLine', { tables: summary.entities.length ? summary.entities.join(t('flows.listSeparator')) : t('flows.noTables') }),
            t('flows.connectorsLine', { connectors: summary.connectors.length ? summary.connectors.join(t('flows.listSeparator')) : '—' }),
          ]
          if (summary.connectionReferences.length) lines.push(t('flows.referencesLine', { values: summary.connectionReferences.join(t('flows.listSeparator')) }))
          const steps = summary.steps.length
            ? formatTable(summary.steps.slice(0, 40).map((step) => ({
              step: step.path,
              type: step.type,
              'connector/operation': [step.connector, step.operation].filter(Boolean).join(' / ') || '—',
              entity: step.entities.join(t('flows.listSeparator')) || '—',
              detail: step.detail || '—',
            })), ['step', 'type', 'connector/operation', 'entity'], { width: 40 })
            : t('flows.noActions')
          if (summary.steps.length > 40) lines.push(t('flows.stepsOmitted', { count: summary.steps.length - 40 }))
          reports[index] = [...lines, '', steps].join('\n')
          return
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
              where: t('flows.whereTrigger', { name: trigger.name }),
              operation: trigger.operation || trigger.kind,
              entity: trigger.entities.join(t('flows.listSeparator')),
            })
          }
          for (const step of flattenActions(parsed.definition?.actions)) {
            if (!step.entities.some((name) => sameEntity(name, args.entity))) continue
            hits.push({
              flow: row.name,
              state: stateLabel(row.statecode),
              where: t('flows.whereAction', { path: step.path }),
              operation: [step.connector, step.operation].filter(Boolean).join(' / ') || step.type,
              entity: step.entities.join(t('flows.listSeparator')),
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
          ? t('flows.refsHead', { env: env.key, count: flows.size, entity: args.entity, parsed: parsedCount, rows: rows.length, limited: page.hasMore ? t('flows.scanLimited', { limit: scanLimit }) : '' })
          : t('flows.refsEmptyHead', { env: env.key, parsed: parsedCount, entity: args.entity, limited: page.hasMore ? t('flows.scanPartial', { limit: scanLimit }) : '' })
        const table = hits.length
          ? formatTable(hits.map((hit) => ({
            flow: hit.flow,
            state: hit.state,
            where: hit.where,
            'operation': hit.operation,
          })), ['flow', 'state', 'where', 'operation'], { width: 44 })
          : ''
        reports[index] = [head, table].filter(Boolean).join('\n')
        } catch (error) {
          // One environment failing must not erase the others.
          reports[index] = [
            t('flows.queryFailed', { env: env.key }),
            `- ${error?.message ?? String(error)}`,
            error?.hint ? t('flows.hintLine', { hint: error.hint }) : '',
          ].filter(Boolean).join('\n')
        }
      })

      const file = await writeArtifact(config, `flows-${action}`, artifact)
      return { text: `${reports.join('\n\n')}\n\n${t('flows.fullResult', { file })}` }
    },
  })
}
