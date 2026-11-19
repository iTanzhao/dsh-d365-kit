/**
 * `d365_data_sync` — business records from one environment to another.
 *
 * The plan is read-only and says everything a person needs before deciding:
 * how many rows, which columns, how every lookup resolved, whether plugins will
 * be bypassed. Execution re-asks on a confirmation card, so a plan file alone
 * can never write.
 */
import { loadConfig } from './config.js'
import { t } from './i18n.js'
import { D365Error } from './errors.js'
import { allows, readPolicy } from './write-policy.js'
import {
  buildPlan,
  buildUpdatePlan,
  claimMigrationPlan,
  deleteMigrationPlan,
  executeMigration,
  executeUpdate,
  releaseMigrationPlan,
  listMigrationPlans,
  readMigrationPlan,
  saveMigrationPlan,
  setMigrationPlanStatus,
  writePlanArtifact,
} from './data-migrate.js'

const ACTIONS = ['plan', 'plan-update', 'show', 'list', 'cancel', 'execute']
const APPROVE = () => t('sync.approve')
const CANCEL = () => t('sync.cancel')
const CONFIRM_ID = 'd365-data-sync-confirm'

export const definition = {
  name: 'd365_data_sync',
  description: 'Migrate or update business records in bulk. plan is read-only; execute requires confirmation, source/target data.read and target data.write. No condition means the whole table.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'plan is a read-only preview; plan-update changes explicit IDs; show/list/cancel manage plans; execute runs after confirmation. Defaults to plan.',
      },
      source: { type: 'string', description: 'Source environment key, such as dev.' },
      target: { type: 'string', description: 'Target environment key, such as sit.' },
      environment: { type: 'string', description: 'For plan-update: single environment to update.' },
      values: {
        type: 'object',
        additionalProperties: true,
        description: 'For plan-update: logical-name scalar values, such as {"statecode":0}; use d365_data_write for lookups.',
      },
      entity: { type: 'string', description: 'Entity logical name or collection name, such as account/accounts.' },
      since: { type: 'string', description: 'ISO start of the time window; defaults to createdon, or modifiedon when mode=modified.' },
      mode: {
        type: 'string',
        enum: ['new', 'modified', 'all'],
        description: 'new selects rows created since (default createdon); modified selects changed rows; all selects the whole table. With no since/filter/ids, selects all.',
      },
      filter: { type: 'string', description: 'Additional OData $filter, such as "statecode eq 0"; combined with since by AND.' },
      ids: { type: 'array', items: { type: 'string' }, description: 'Primary-key GUIDs to migrate; required explicit update list for plan-update.' },
      fetchXml: { type: 'string', description: 'FetchXML selection; takes precedence over mutually exclusive filter/ids.' },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Logical-name fields to migrate; omit for all writable fields. Including the primary key preserves GUIDs; otherwise the target assigns them.',
      },
      keepGuid: { type: 'boolean', description: 'Omitted follows fields: a primary key preserves GUIDs. false lets the target assign GUIDs and remaps batch references.' },
      includeLookups: { type: 'boolean', description: 'Defaults true: resolve lookups by GUID, then name. false checks GUID existence only.' },
      ownerMode: {
        type: 'string',
        enum: ['map', 'keep', 'caller'],
        description: 'map resolves by domain/email, defaulting unmatched owners to the caller; keep retains GUID; caller assigns to execution user.',
      },
      conflict: {
        type: 'string',
        enum: ['report', 'skip', 'overwrite'],
        description: 'Existing target GUID: report does not write (default); skip ignores; overwrite replaces, and must be explicitly enabled at execute.',
      },
      onMissingLookup: {
        type: 'string',
        enum: ['report', 'null', 'fail'],
        description: 'Unresolved target reference: report skips and reports rows (default); null clears it; fail rejects the entire plan.',
      },
      bypassPlugins: {
        type: 'boolean',
        description: 'Defaults true (bypass synchronous target plug-ins). false executes plug-ins and may trigger notifications/integrations.',
      },
      preserveCreatedOn: { type: 'boolean', description: 'Defaults true: preserve source creation time using overriddencreatedon.' },
      suppressDuplicateDetection: { type: 'boolean', description: 'Defaults true: send MSCRM.SuppressDuplicateDetection to avoid target duplicate rules rejecting creation.' },
      includeState: { type: 'boolean', description: 'Defaults false: do not migrate statecode/statuscode; target defaults apply.' },
      maxRecords: { type: 'integer', description: 'Maximum rows to read, default 500, maximum 5000.' },
      concurrency: { type: 'integer', description: 'Write-request concurrency, default 4, maximum 8.' },
      planId: { type: 'string', description: 'Plan id for show/cancel/execute.' },
      rationale: { type: 'string', description: 'Migration reason recorded in the plan and execution log.' },
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
  return t(value ? 'common.yes' : 'common.no')
}

/**
 * How many rows execute would really write.
 *
 * `counts.blocked` counts every row with an unresolved reference, while
 * `counts.create` already leaves conflicts out — subtracting the whole blocked
 * count from create is what could print a negative write count. Derive each
 * bucket once here from the create/conflict split the plan records.
 * @returns `{ created, overwritten, total }`
 */
export function writeTotals(plan, options) {
  const counts = plan.counts ?? {}
  const blocked = counts.blocked ?? 0
  const create = counts.create ?? 0
  const conflict = counts.conflict ?? 0
  const blockedCreate = counts.blockedCreate ?? Math.min(blocked, create)
  const blockedConflict = counts.blockedConflict ?? Math.max(0, blocked - blockedCreate)
  const skipBlocked = options.onMissingLookup === 'report'
  const created = Math.max(0, create - (skipBlocked ? blockedCreate : 0))
  const overwritten = options.conflict === 'overwrite'
    ? Math.max(0, conflict - (skipBlocked ? blockedConflict : 0))
    : 0
  return { created, overwritten, total: created + overwritten }
}

function willWrite(plan, options) {
  return writeTotals(plan, options).total
}

function renderPlan(plan) {
  const { counts, options, lookupSummary, fields, owners, limits } = plan
  const lines = [t('sync.plan.heading', { id: plan.id })]
  lines.push(t('sync.plan.route', { source: plan.source.key, sourceEntity: plan.source.entity, target: plan.target.key, targetEntity: plan.target.entity }))
  if (plan.rationale) lines.push(t('sync.plan.rationale', { value: plan.rationale }))
  lines.push(t('sync.plan.scope', { value: plan.scope.description }))
  lines.push(t('sync.plan.read', { read: limits.read, extra: limits.hasMore ? t('sync.plan.readMore', { max: limits.maxRecords }) : '' }))
  lines.push('')

  lines.push(`| ${t('sync.col.item')} | ${t('sync.col.count')} |`)
  lines.push('| --- | --- |')
  lines.push(`| ${t('sync.plan.willWrite')} | ${willWrite(plan, options)} |`)
  lines.push(`| ${t('sync.plan.create')} | ${counts.create} |`)
  lines.push(`| ${t('sync.plan.blocked')} | ${counts.blockedCreate ?? counts.blocked}${counts.blockedConflict ? t('sync.plan.blockedConflict', { count: counts.blockedConflict }) : ''} |`)
  lines.push(`| ${t('sync.plan.conflict')} | ${counts.conflict}${t(options.conflict === 'overwrite' ? 'sync.plan.overwrite' : 'sync.plan.noOverwrite')} |`)
  lines.push(`| ${t('sync.plan.lookupTotal')} | ${counts.missingLookups} |`)
  lines.push('')

  const plain = fields.filter((field) => !field.lookup).map((field) => field.name)
  const lookups = fields.filter((field) => field.lookup)
  const plainText = plain.length > 40
    ? `${plain.slice(0, 40).join(', ')} ${t('sync.plan.moreFields', { count: plain.length - 40 })}`
    : (plain.join(', ') || t('sync.plan.noPlainFields'))
  lines.push(t('sync.plan.fields', { count: fields.length, lookups: lookups.length, text: plainText }))
  if (lookups.length) {
    lines.push(t('sync.plan.lookupFields', { count: lookups.length, text: lookups.map((field) => `${field.name}(${field.targets.join('|') || '?'})`).join(', ') }))
    const renamed = lookups.filter((field) => field.navigation && field.navigation !== field.name)
    if (renamed.length) {
      lines.push(t('sync.plan.renamed', { text: renamed.map((field) => `${field.name} → ${field.navigation}`).join(', ') }))
    }
  }
  lines.push('')

  if (lookupSummary.length) {
    const hasBatch = lookupSummary.some((entry) => entry.inBatch)
    lines.push(t('sync.plan.lookupStatus'))
    lines.push(t('sync.plan.lookupHeader', { batch: hasBatch ? t('sync.plan.batchHeader') : '' }))
    lines.push(`| --- | --- | --- | --- |${hasBatch ? ' --- |' : ''} --- | --- | --- |`)
    for (const entry of lookupSummary) {
      lines.push(`| ${entry.attribute} | ${entry.filled} | ${entry.sameGuid} | ${entry.byName} |${hasBatch ? ` ${entry.inBatch} |` : ''} ${entry.missing} | ${entry.ambiguous} | ${entry.empty} |`)
    }
    const samples = lookupSummary.flatMap((entry) => (entry.missingSamples ?? []).map((sample) => ({ ...sample, attribute: entry.attribute })))
    if (samples.length) {
      lines.push('')
      lines.push(t('sync.plan.unresolved'))
      for (const sample of samples.slice(0, 10)) {
        lines.push(`- ${sample.attribute}: ${sample.name ?? sample.sourceId} — ${sample.reason ?? t('sync.plan.targetMissing')}`)
      }
    }
    lines.push('')
  }

  if (owners.distinct) {
    lines.push(t('sync.plan.owners', {
      distinct: owners.distinct,
      mapped: owners.mapped,
      fallback: owners.fallback,
      mode: t(options.ownerMode === 'caller' ? 'sync.owner.caller' : 'sync.owner.fallback'),
    }))
    lines.push('')
  }

  lines.push(t('sync.plan.writeOptions'))
  lines.push(`- ${t('sync.opt.keepGuid')}: ${yesNo(options.keepGuid)}${options.keepGuid ? '' : t('sync.opt.remap')}`)
  lines.push(`- ${t('sync.opt.created')}: ${yesNo(options.preserveCreatedOn)}`)
  lines.push(`- ${t('sync.opt.bypass')}: ${yesNo(options.bypassPlugins)}${t(options.bypassPlugins ? 'sync.opt.bypassOn' : 'sync.opt.bypassOff')}`)
  lines.push(`- ${t('sync.opt.duplicate')}: ${yesNo(options.suppressDuplicateDetection)}`)
  lines.push(`- ${t('sync.opt.conflict')}: ${options.conflict}`)
  lines.push(`- ${t('sync.opt.missing')}: ${options.onMissingLookup}`)
  lines.push(`- ${t('sync.opt.state')}: ${yesNo(options.includeState)}`)
  lines.push(`- ${t('sync.opt.concurrency')}: ${options.concurrency}`)
  lines.push('')

  const warnings = plan.warnings ?? []
  if (warnings.length) {
    lines.push(t('sync.plan.warnings'))
    for (const warning of warnings) lines.push(`- ${warning}`)
    lines.push('')
  }

  const permissions = plan.permissions
  if (permissions) {
    const read = (key) => t(permissions[key] ? 'common.enabled' : 'common.disabled')
    lines.push(t('sync.plan.permissions'))
    lines.push(`- ${t('sync.plan.sourceRead', { env: plan.source.key })}: ${read('sourceRead')}`)
    lines.push(`- ${t('sync.plan.targetRead', { env: plan.target.key })}: ${read('targetRead')}`)
    lines.push(`- ${t('sync.plan.targetWrite', { env: plan.target.key })}: ${permissions.targetWrite ? t('common.enabled') : t('sync.plan.writeEnableHint')}`)
    lines.push('')
  }

  lines.push(t('sync.plan.confirmIntro'))
  lines.push(`- ${t('sync.plan.condition')}: ${plan.scope.description}${plan.scope.implicit ? t('sync.plan.scopeHint') : ''}`)
  lines.push(`- ${t('sync.plan.fieldCheck')}: ${fields.length}${options.keepGuid
    ? t('sync.plan.fieldsGuid', { id: plan.idField ?? `${plan.source.entity}id` })
    : t('sync.plan.fieldsNoGuid')}`)
  lines.push(`- ${t('sync.opt.bypass')}: ${yesNo(options.bypassPlugins)}${options.bypassPlugins ? t('sync.plan.bypassDefault') : ''}`)
  lines.push('')

  if (permissions && !permissions.targetWrite) {
    lines.push(t('sync.plan.enableBefore', { env: plan.target.key }))
  } else {
    lines.push(t('sync.plan.executeInstruction'))
  }
  lines.push(t('sync.plan.noWrite'))
  return lines.join('\n')
}

function renderConfirmation(plan, options) {
  const { created, overwritten } = writeTotals(plan, options)
  const lines = [t('sync.confirm.route', { source: plan.source.key, target: plan.target.key, entity: plan.target.entity })]
  lines.push(t('sync.confirm.scope', { scope: plan.scope.description }))
  lines.push(t('sync.confirm.write', {
    total: created + overwritten,
    created,
    overwritten: overwritten ? t('sync.confirm.overwritten', { count: overwritten }) : '',
  }))
  if (options.conflict !== 'overwrite' && plan.counts.conflict) {
    lines.push(t('sync.confirm.skippedConflict', { count: plan.counts.conflict }))
  }
  if (options.onMissingLookup === 'report' && plan.counts.blocked) {
    lines.push(t('sync.confirm.missingSkipped', { count: plan.counts.blocked }))
  }
  const inBatch = plan.lookupSummary.reduce((sum, item) => sum + (item.inBatch ?? 0), 0)
  lines.push(t('sync.confirm.summary', {
    fields: plan.fields.length,
    guid: plan.lookupSummary.reduce((sum, item) => sum + item.sameGuid, 0),
    name: plan.lookupSummary.reduce((sum, item) => sum + item.byName, 0),
    batch: inBatch ? t('sync.confirm.batch', { count: inBatch }) : '',
  }))
  lines.push(t('sync.confirm.bypass', { value: yesNo(options.bypassPlugins) }))
  lines.push(t('sync.confirm.flags', {
    guid: yesNo(options.keepGuid),
    created: yesNo(options.preserveCreatedOn),
    duplicate: yesNo(options.suppressDuplicateDetection),
  }))
  lines.push('', t('sync.confirm.warning'))
  return lines.join('\n')
}

function renderRun(plan, run) {
  const lines = [t('sync.run.heading', { plan: plan.id, run: run.runId })]
  lines.push(t('sync.run.counts', {
    written: run.counts.written,
    created: run.created.length,
    updated: run.updated.length,
    skipped: run.counts.skipped,
    failed: run.counts.failed,
  }))
  if (run.skippedRecords.length) {
    lines.push('')
    lines.push(t('sync.run.skipped', { items: run.skippedRecords.slice(0, 5).map((record) => `${record.id} — ${record.reason}`).join('; ') }))
  }
  if (run.failures.length) {
    lines.push('')
    lines.push(t('sync.run.failures'))
    for (const failure of run.failures.slice(0, 10)) lines.push(`- ${failure.id}: ${failure.error}`)
    if (run.failures.length > 10) lines.push(t('sync.run.moreFailures', { count: run.failures.length - 10 }))
  }
  lines.push('', t('sync.run.artifact', { file: run.file }))
  return lines.join('\n')
}

function assertPlanEnvironment(config, plan) {
  if (plan.kind === 'data-update') {
    const env = config.environments[plan.environment]
    if (!env || String(env.url).replace(/\/$/, '') !== String(plan.url).replace(/\/$/, '')) {
      throw new D365Error(`Environment ${plan.environment} no longer points to the planned organization`, {
        code: 'environment-changed',
        hint: 'Create and review a new plan before executing.',
      })
    }
    return
  }
  for (const saved of [plan.source, plan.target]) {
    const env = config.environments[saved.key]
    if (!env || String(env.url).replace(/\/$/, '') !== String(saved.url).replace(/\/$/, '')) {
      throw new D365Error(`Environment ${saved.key} no longer points to the planned organization`, {
        code: 'environment-changed',
        hint: 'Create and review a new plan before executing.',
      })
    }
  }
}

function checkEnvironments(config, args) {
  const sourceKey = String(args.source ?? '').trim()
  const targetKey = String(args.target ?? '').trim()
  if (!sourceKey || !targetKey) {
    throw new D365Error(t('sync.error.missingEnvironments'), {
      code: 'missing-environment',
      hint: t('sync.error.environmentHint', { envs: Object.keys(config.environments).join(', ') }),
    })
  }
  if (sourceKey === targetKey) throw new D365Error(t('sync.error.sameEnvironment'), { code: 'same-environment' })
  if (!config.environments[sourceKey]) throw new D365Error(t('sync.error.sourceMissing', { env: sourceKey }), { hint: t('sync.error.available', { envs: Object.keys(config.environments).join(', ') }) })
  if (!config.environments[targetKey]) throw new D365Error(t('sync.error.targetMissing', { env: targetKey }), { hint: t('sync.error.available', { envs: Object.keys(config.environments).join(', ') }) })
  return { sourceKey, targetKey }
}

function renderUpdatePlan(plan) {
  const lines = [t('sync.update.heading', { id: plan.id })]
  lines.push(t('sync.update.environment', { env: plan.environment, entity: plan.entity }))
  lines.push(t('sync.update.records', {
    ids: plan.ids.length,
    existing: plan.counts.existing,
    missing: plan.counts.missing ? t('sync.update.missingRecords', { count: plan.counts.missing }) : '',
  }))
  lines.push('')
  lines.push(t('sync.update.fieldsHeading', { count: plan.fields.length }))
  for (const field of plan.fields) {
    const value = plan.values[field.name]
    lines.push(`- ${field.name} (${field.type}): ${JSON.stringify(value)}`)
  }
  lines.push('')
  if (plan.before.length) {
    lines.push(t('sync.update.preview'))
    for (const row of plan.before.slice(0, 5)) {
      const before = plan.fields.map((field) => `${field.name}=${JSON.stringify(row.current[field.name] ?? null)}`).join(', ')
      lines.push(`- ${row.name ?? row.id}: ${before}`)
    }
    if (plan.before.length > 5) lines.push(t('sync.update.morePreview', { count: plan.before.length - 5 }))
    lines.push('')
  }
  if (plan.missing.length) {
    lines.push(t('sync.update.missingIds', { ids: plan.missing.slice(0, 5).join(', '), more: plan.missing.length > 5 ? ' …' : '' }))
    lines.push('')
  }
  lines.push(t('sync.plan.writeOptions'))
  lines.push(`- ${t('sync.opt.bypass')}: ${yesNo(plan.options.bypassPlugins)}`)
  lines.push(`- ${t('sync.opt.duplicate')}: ${yesNo(plan.options.suppressDuplicateDetection)}`)
  lines.push(`- ${t('sync.opt.concurrency')}: ${plan.options.concurrency}`)
  lines.push('')
  lines.push(t('sync.update.confirmIntro'))
  lines.push(t('sync.update.scope', { count: plan.ids.length }))
  lines.push(t('sync.update.fieldList', { fields: plan.fields.map((field) => field.name).join(', ') }))
  lines.push(`- ${t('sync.opt.bypass')}: ${yesNo(plan.options.bypassPlugins)}`)
  lines.push('')
  lines.push(t('sync.update.executeInstruction'))
  lines.push(t('sync.plan.noWrite'))
  return lines.join('\n')
}

function renderUpdateConfirmation(plan, options = plan.options) {
  const lines = [t('sync.update.environment', { env: plan.environment, entity: plan.entity })]
  lines.push(t('sync.update.willUpdate', { count: plan.before.length }))
  lines.push(t('sync.update.fields', { fields: plan.fields.map((field) => `${field.name}=${JSON.stringify(plan.values[field.name])}`).join(', ') }))
  if (plan.missing.length) lines.push(t('sync.update.missingSkipped', { count: plan.missing.length }))
  lines.push(t('sync.update.flags', {
    bypass: yesNo(options.bypassPlugins),
    duplicate: yesNo(options.suppressDuplicateDetection),
  }))
  lines.push(`- ${t('sync.opt.concurrency')}: ${options.concurrency}`)
  lines.push('', t('sync.update.warning'))
  return lines.join('\n')
}

function renderUpdateRun(plan, run) {
  const lines = [t('sync.update.runHeading', { plan: plan.id, run: run.runId })]
  lines.push(t('sync.update.runCounts', { updated: run.counts.updated, failed: run.counts.failed, missing: run.counts.missing }))
  if (run.failures.length) {
    lines.push('')
    for (const failure of run.failures.slice(0, 10)) lines.push(`- ${failure.id}: ${failure.error}`)
    if (run.failures.length > 10) lines.push(t('sync.run.moreFailures', { count: run.failures.length - 10 }))
  }
  lines.push('', t('sync.run.artifact', { file: run.file }))
  return lines.join('\n')
}

async function executeUpdatePlan(ctx, config, plan, args, exec) {
  const userQuestions = ctx.userQuestions ?? ctx.get('userQuestions')
  const policy = await readPolicy(config.configFile)
  if (!allows(policy, plan.environment, 'data.write')) {
    throw new D365Error(t('sync.error.writeForbidden', { env: plan.environment }), {
      code: 'data-write-forbidden',
      hint: t('sync.hint.enableWrite', { env: plan.environment }),
    })
  }
  if (!userQuestions?.ask) {
    throw new D365Error(t('sync.noConfirmation'), { hint: t('sync.hint.updateConfirmation') })
  }
  if (!exec?.agent) throw new D365Error(t('sync.interactiveRequired'), { hint: t('sync.hint.mainConversation') })

  const effective = {
    bypassPlugins: typeof args.bypassPlugins === 'boolean' ? args.bypassPlugins : plan.options.bypassPlugins,
    suppressDuplicateDetection: typeof args.suppressDuplicateDetection === 'boolean'
      ? args.suppressDuplicateDetection
      : plan.options.suppressDuplicateDetection,
    concurrency: Number.isFinite(args.concurrency)
      ? Math.max(1, Math.min(8, Number(args.concurrency)))
      : plan.options.concurrency,
  }
  const answer = await userQuestions.ask({
    questions: [{
      id: CONFIRM_ID,
      header: t('sync.confirm.updateHeader', { env: plan.environment }),
      question: t('sync.confirm.updateQuestion', { env: plan.environment, count: plan.before.length, entity: plan.entity }),
      detail: renderUpdateConfirmation(plan, effective),
      options: [
        { label: APPROVE(), description: t('sync.confirm.writeNow') },
        { label: CANCEL(), description: t('sync.confirm.keepPlan') },
      ],
    }],
    agent: exec.agent,
    ...(exec.signal ? { signal: exec.signal } : {}),
    wait: { callId: exec.callId },
  })
  const chosen = answer?.answers?.find((item) => item.id === CONFIRM_ID)?.selected?.[0]
  if (chosen !== APPROVE()) return { text: t('sync.cancelledPending', { id: plan.id }) }

  const lock = await claimMigrationPlan(config, plan.id)
  let markedRunning = false
  try {
    const claimed = await readMigrationPlan(config, plan.id)
    if (!claimed || (claimed.status ?? 'pending') !== 'pending') {
      throw new D365Error(t('sync.error.notPending', { id: plan.id, status: claimed?.status }), { code: 'plan-not-pending' })
    }
    assertPlanEnvironment(config, claimed)
    await setMigrationPlanStatus(config, plan.id, 'running', undefined, 'pending')
    markedRunning = true
    const run = await executeUpdate(config, claimed, effective, exec.signal)
    await setMigrationPlanStatus(config, plan.id, 'done', { runId: run.runId, executedAt: run.at })
    return { text: renderUpdateRun(claimed, run) }
  } catch (error) {
    if (markedRunning) {
      await setMigrationPlanStatus(config, plan.id, 'failed', { error: String(error?.message ?? error) }, 'running').catch(() => {})
    }
    throw error
  } finally {
    if (lock) await releaseMigrationPlan(config, plan.id)
  }
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args = {}, exec) {
      const config = await loadConfig(state.rawConfig)
      const action = args.action ?? 'plan'
      const policy = await readPolicy(config.configFile)

      if (action === 'plan-update') {
        const environment = String(args.environment ?? '').trim()
        if (!environment) {
          throw new D365Error(t('sync.error.updateEnvironmentRequired'), {
            code: 'missing-environment',
            hint: t('sync.hint.singleEnvironment'),
          })
        }
        if (!allows(policy, environment, 'data.read')) {
          throw new D365Error(t('sync.error.readForbidden', { env: environment }), {
            code: 'data-read-forbidden',
            hint: t('sync.hint.updateRead', { env: environment }),
          })
        }
        const plan = await buildUpdatePlan(config, args, exec?.signal)
        plan.rationale = args.rationale
        await saveMigrationPlan(config, plan)
        return { text: renderUpdatePlan(plan) }
      }

      if (action === 'list') {
        const plans = await listMigrationPlans(config)
        if (!plans.length) return { text: t('sync.list.empty') }
        const pending = plans.filter((plan) => (plan.status ?? 'pending') === 'pending')
        const finished = plans.filter((plan) => (plan.status ?? 'pending') !== 'pending')
        const summaryOf = (plan) => (plan.kind === 'data-update'
          ? t('sync.list.updateSummary', { env: plan.environment, entity: plan.entity, count: plan.counts.existing })
          : t('sync.list.migrationSummary', { source: plan.source.key, target: plan.target.key, entity: plan.target.entity, create: plan.counts.create, conflict: plan.counts.conflict, scope: plan.scope.description }))
        const stateOf = (plan) => (plan.status === 'running' ? t('sync.list.interrupted') : plan.status === 'failed' ? t('sync.list.failed') : t('sync.list.done'))
        const lines = []
        if (pending.length) {
          lines.push(t('sync.list.pending', { count: pending.length }), '')
          for (const plan of pending) lines.push(`- ${plan.id}：${summaryOf(plan)}`)
          lines.push('', t('sync.list.nextStep'))
        } else {
          lines.push(t('sync.list.empty'))
        }
        if (finished.length) {
          lines.push('', t('sync.list.finished', { count: finished.length }))
          for (const plan of finished.slice(0, 10)) lines.push(`- ${plan.id}：${summaryOf(plan)}${stateOf(plan)}`)
          if (finished.length > 10) lines.push(t('sync.list.more', { count: finished.length - 10 }))
        }
        return { text: lines.join('\n') }
      }

      if (action === 'show') {
        const id = String(args.planId ?? '').trim()
        if (!id) throw new D365Error(t('sync.error.planIdRequired', { action: 'show' }), { hint: t('sync.hint.useList') })
        const plan = await readMigrationPlan(config, id)
        if (!plan) throw new D365Error(t('sync.error.planNotFound', { id }), { code: 'plan-not-found', hint: t('sync.hint.useList') })
        return { text: plan.kind === 'data-update' ? renderUpdatePlan(plan) : renderPlan(plan) }
      }

      if (action === 'cancel') {
        const id = String(args.planId ?? '').trim()
        if (!id) throw new D365Error(t('sync.error.planIdRequired', { action: 'cancel' }))
        const lock = await claimMigrationPlan(config, id)
        try {
          const current = await readMigrationPlan(config, id)
          if (current && (current.status ?? 'pending') !== 'pending') {
            throw new D365Error(t('sync.error.notPending', { id, status: current.status }), { code: 'plan-not-pending' })
          }
          const removed = await deleteMigrationPlan(config, id)
          return { text: removed ? t('sync.cancelled', { id }) : t('sync.error.planNotFound', { id }) }
        } finally {
          if (lock) await releaseMigrationPlan(config, id)
        }
      }

      if (action === 'execute') {
        const id = String(args.planId ?? '').trim()
        if (!id) throw new D365Error(t('sync.error.planIdRequired', { action: 'execute' }), { hint: t('sync.hint.planThenExecute') })
        const plan = await readMigrationPlan(config, id)
        if (!plan) throw new D365Error(t('sync.error.planNotFound', { id }), { code: 'plan-not-found', hint: t('sync.hint.useList') })
        if ((plan.status ?? 'pending') !== 'pending') {
          throw new D365Error(t('sync.error.notPending', { id, status: plan.status }), {
            code: 'plan-not-pending',
            hint: t('sync.hint.inspectRun'),
          })
        }
        if (plan.kind === 'data-update') {
          return executeUpdatePlan(ctx, config, plan, args, exec)
        }
        const targetKey = plan.target.key
        if (!allows(policy, targetKey, 'data.write')) {
          throw new D365Error(t('sync.error.writeForbidden', { env: targetKey }), {
            code: 'data-write-forbidden',
            hint: t('sync.hint.enableWrite', { env: targetKey }),
          })
        }

        // Execute-time options can narrow what the plan proposed (overwrite,
        // bypass) but the card always states the final values. It must therefore
        // start from the plan's full option set: the card prints keepGuid,
        // preserveCreatedOn and suppressDuplicateDetection too, and an omitted
        // field used to render as "no" while execution used the plan's "yes".
        const effective = {
          ...plan.options,
          conflict: ['report', 'skip', 'overwrite'].includes(args.conflict) ? args.conflict : plan.options.conflict,
          onMissingLookup: ['report', 'null', 'fail'].includes(args.onMissingLookup) ? args.onMissingLookup : plan.options.onMissingLookup,
          bypassPlugins: typeof args.bypassPlugins === 'boolean' ? args.bypassPlugins : plan.options.bypassPlugins,
          concurrency: Number.isFinite(args.concurrency)
            ? Math.max(1, Math.min(8, Number(args.concurrency)))
            : plan.options.concurrency,
        }

        const userQuestions = ctx.get('userQuestions')
        if (!userQuestions?.ask) {
          throw new D365Error(t('sync.noConfirmation'), { hint: t('sync.hint.migrationConfirmation') })
        }
        if (!exec?.agent) throw new D365Error(t('sync.interactiveRequired'), { hint: t('sync.hint.mainConversation') })

        const answer = await userQuestions.ask({
          questions: [{
            id: CONFIRM_ID,
            header: t('sync.confirm.migrationHeader', { source: plan.source.key, target: plan.target.key }),
            question: t('sync.confirm.migrationQuestion', { target: plan.target.key }),
            detail: renderConfirmation(plan, effective),
            options: [
              { label: APPROVE(), description: t('sync.confirm.writeTarget') },
              { label: CANCEL(), description: t('sync.confirm.keepPlan') },
            ],
          }],
          agent: exec.agent,
          ...(exec.signal ? { signal: exec.signal } : {}),
          wait: { callId: exec.callId },
        })
        const chosen = answer?.answers?.find((item) => item.id === CONFIRM_ID)?.selected?.[0]
        if (chosen !== APPROVE()) return { text: t('sync.cancelledPending', { id }) }

        const lock = await claimMigrationPlan(config, id)
        let markedRunning = false
        try {
          const claimed = await readMigrationPlan(config, id)
          if (!claimed || (claimed.status ?? 'pending') !== 'pending') {
            throw new D365Error(t('sync.error.notPending', { id, status: claimed?.status }), { code: 'plan-not-pending' })
          }
          assertPlanEnvironment(config, claimed)
          await setMigrationPlanStatus(config, id, 'running', undefined, 'pending')
          markedRunning = true
          const run = await executeMigration(config, claimed, effective, exec.signal)
          await setMigrationPlanStatus(config, id, 'done', { runId: run.runId, executedAt: run.at })
          return { text: renderRun(claimed, run) }
        } catch (error) {
          if (markedRunning) {
            await setMigrationPlanStatus(config, id, 'failed', { error: String(error?.message ?? error) }, 'running').catch(() => {})
          }
          throw error
        } finally {
          if (lock) await releaseMigrationPlan(config, id)
        }
      }

      // action === 'plan'
      const { sourceKey, targetKey } = checkEnvironments(config, args)
      for (const key of [sourceKey, targetKey]) {
        if (!allows(policy, key, 'data.read')) {
          throw new D365Error(t('sync.error.readForbidden', { env: key }), {
            code: 'data-read-forbidden',
            hint: t('sync.hint.planRead', { env: key }),
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
      const text = `${renderPlan(plan)}\n${t('sync.fullPlan', { file: artifact })}`
      return { text }
    },
    presentCall(args = {}) {
      return { card: 'generic', title: t('sync.toolTitle', { action: args.action ?? 'plan' }), kind: 'other', rawInput: args }
    },
  })
}
