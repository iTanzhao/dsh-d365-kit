/**
 * `d365_contract` — plugin registration as a contract, plus the drift rules
 * that check whether downstream environments still honour it.
 *
 * Actions:
 *   drift   — compare upstream with downstream, apply waivers, show trend
 *   matrix  — same read, only the environment overview
 *   waive   — record an accepted difference (with reason and expiry)
 *   waivers — list recorded waivers
 */

import { loadConfig } from './config.js'
import { D365Error } from './errors.js'
import {
  RULES,
  compareContracts,
  compareHandlers,
  compareOptionValues,
  compareVisualContract,
  detectHandlerPrefixes,
  indexContract,
  openContractClients,
  readContractFacts,
  renderContractMarkdown,
  writeContractReport,
} from './contract.js'
import { addWaiver, applyWaivers, readWaivers, waiversPath } from './waivers.js'
import { appendHistory, compareWithPrevious, findingKey, readHistory } from './contract-history.js'
import { enforceRetention } from './retention.js'
import { t } from './i18n.js'

const ACTIONS = ['drift', 'matrix', 'waive', 'waivers']

function pickEnvironments(config, args) {
  const keys = Object.keys(config.environments)
  if (!keys.length) throw new D365Error(t('toolContract.noEnvironments'), { hint: t('toolContract.addEnvironment') })
  const source = args.source ?? config.defaultEnvironment ?? keys[0]
  if (!config.environments[source]) {
    throw new D365Error(t('toolContract.unknownEnvironment', { env: source }), { hint: t('toolContract.available', { values: keys.join(', ') }) })
  }
  const requested = Array.isArray(args.targets) && args.targets.length ? args.targets : keys.filter((key) => key !== source)
  const targets = [...new Set(requested)].filter((key) => key !== source)
  for (const key of targets) {
    if (!config.environments[key]) throw new D365Error(t('toolContract.unknownEnvironment', { env: key }), { hint: t('toolContract.available', { values: keys.join(', ') }) })
  }
  if (!targets.length) throw new D365Error(t('toolContract.noTargets'), { hint: t('toolContract.noTargetsHint') })
  return { source, targets }
}

function render(value) {
  const lines = []
  if (value.action === 'waivers') {
    lines.push(t('toolContract.waiversTitle', { count: value.waivers.length, path: value.waiversPath }))
    for (const waiver of value.waivers) lines.push(t('toolContract.waiverRow', { rule: waiver.rule, env: waiver.env, object: waiver.object, expires: waiver.expiresAt ? t('toolContract.expires', { at: waiver.expiresAt }) : '', reason: waiver.reason }))
    return [{ type: 'text', text: lines.join('\n') }]
  }
  if (value.action === 'waive') {
    lines.push(t('toolContract.waiverSaved', { count: value.waivers.length, path: value.waiversPath }))
    lines.push(t('toolContract.waiverBehavior'))
    return [{ type: 'text', text: lines.join('\n') }]
  }
  lines.push(t(value.action === 'matrix' ? 'toolContract.matrix' : 'toolContract.drift'))
  lines.push('')
  lines.push(t('toolContract.route', { source: value.source, targets: value.targets.join(', ') }))
  lines.push('')
  lines.push(t('toolContract.tableHeader'))
  lines.push('| --- | --- | --- | --- |')
  for (const row of value.rows) lines.push(`| ${row.env} | ${row.assemblies} | ${row.types} | ${row.steps} |`)
  lines.push('')
  if (value.handlerPrefixes?.length) {
    const source = t(value.handlerPrefixSource === 'config' ? 'toolContract.fromConfig' : 'toolContract.fromPublishers')
    lines.push(t('toolContract.handlerPrefixes', { values: value.handlerPrefixes.join(', '), source }))
    lines.push('')
  }
  if (value.trend) { lines.push(t('toolContract.trend', { at: value.trend.comparedTo, added: value.trend.added.length, fixed: value.trend.fixed.length })); lines.push('') }
  if (value.waived) {
    lines.push(t('toolContract.waived', { count: value.waived }))
    if (value.expired) lines.push(t('toolContract.expired', { count: value.expired }))
    lines.push('')
  }
  const section = (titleKey, items, limit) => {
    lines.push(t(titleKey, { count: items.length }))
    if (!items.length) lines.push(t('toolContract.none'))
    else {
      for (const item of items.slice(0, limit)) lines.push(t('toolContract.finding', { env: item.env, message: item.message, evidence: item.evidence ? ` — ${item.evidence}` : '' }))
      if (items.length > limit) lines.push(t('toolContract.more', { count: items.length - limit }))
    }
    lines.push('')
  }
  section('toolContract.blockers', value.findings.filter((item) => item.severity === 'blocker'), 15)
  section('toolContract.warnings', value.findings.filter((item) => item.severity !== 'blocker'), 15)
  lines.push(t('toolContract.report', { path: value.reportPath }))
  return [{ type: 'text', text: lines.join('\n') }]
}

export function register(ctx, state) {
  const dispose = ctx.tools.register({
    name: 'd365_contract',
    description: 'Compare plug-in registration contracts between upstream and downstream environments, including version drift and optional global option-set values. Supports waivers and trend comparison; read-only except that waive writes local waivers.json.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'drift runs rules (default); matrix shows scope; waive records an exemption; waivers lists exemptions.',
        },
        source: { type: 'string', description: 'Source environment key, defaulting to the configured default.' },
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Target environment keys; defaults to all environments except the source.',
        },
        optionSets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Global option sets to compare value-by-value, such as ["contoso_taxcategoryos"].',
        },
        includeManaged: {
          type: 'boolean',
          description: 'By default compares only unmanaged source assemblies; true includes managed assemblies and adds noise.',
        },
        forms: {
          type: 'boolean',
          description: 'By default checks form web resources and sitemaps; false skips formxml reads.',
        },
        handlers: {
          type: 'boolean',
          description: 'When true, downloads script content to verify handler functions (slower; at most 400 scripts per environment).',
        },
        rule: { type: 'string', enum: RULES.map((rule) => rule.id), description: 'For waive: rule to exempt.' },
        env: { type: 'string', description: 'For waive: environment, or * for all.' },
        object: { type: 'string', description: 'For waive: object such as type, assembly, or option-set name; supports * prefix.' },
        reason: { type: 'string', description: 'For waive: required justification for accepting the difference.' },
        days: { type: 'number', description: 'For waive: expiry in days, default 30.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['schemaVersion', 'action'],
        properties: {
          schemaVersion: { type: 'number' },
          action: { type: 'string' },
          source: { type: 'string' },
          targets: { type: 'array', items: { type: 'string' } },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                env: { type: 'string' },
                assemblies: { type: 'number' },
                types: { type: 'number' },
                steps: { type: 'number' },
              },
            },
          },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                rule: { type: 'string' },
                severity: { type: 'string' },
                env: { type: 'string' },
                object: { type: 'string' },
                message: { type: 'string' },
                evidence: { type: 'string' },
              },
            },
          },
          waived: { type: 'number' },
          expired: { type: 'number' },
          handlerPrefixes: { type: 'array', items: { type: 'string' } },
          handlerPrefixSource: { type: 'string' },
          trend: {
            type: 'object',
            additionalProperties: false,
            properties: {
              comparedTo: { type: 'string' },
              added: { type: 'array', items: { type: 'string' } },
              fixed: { type: 'array', items: { type: 'string' } },
            },
          },
          reportPath: { type: 'string' },
          waivers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                rule: { type: 'string' },
                env: { type: 'string' },
                object: { type: 'string' },
                reason: { type: 'string' },
                expiresAt: { type: 'string' },
              },
            },
          },
          waiversPath: { type: 'string' },
        },
      },
      render: (args, value) => render(value),
    },
    async execute(args, exec) {
      const config = await loadConfig(state.rawConfig)
      const action = ACTIONS.includes(args.action) ? args.action : 'drift'

      if (action === 'waivers') {
        const document = await readWaivers(config)
        return {
          schemaVersion: 1,
          action: 'waivers',
          waivers: document.waivers.map((waiver) => ({ ...waiver, expiresAt: waiver.expiresAt ?? '' })),
          waiversPath: waiversPath(config),
        }
      }

      if (action === 'waive') {
        if (!args.rule) throw new D365Error(t('toolContract.ruleRequired'), { hint: t('toolContract.available', { values: RULES.map((rule) => rule.id).join(', ') }) })
        if (!args.env) throw new D365Error(t('toolContract.envRequired'), { hint: t('toolContract.envHint') })
        if (!args.object) throw new D365Error(t('toolContract.objectRequired'), { hint: t('toolContract.objectHint') })
        if (!args.reason || !String(args.reason).trim()) {
          throw new D365Error(t('toolContract.reasonRequired'), { hint: t('toolContract.reasonHint') })
        }
        const days = Number.isFinite(args.days) && args.days > 0 ? args.days : 30
        const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString()
        const waivers = await addWaiver(config, {
          rule: args.rule,
          env: args.env,
          object: args.object,
          reason: String(args.reason).trim(),
          expiresAt,
        })
        return { schemaVersion: 1, action: 'waive', waivers, waiversPath: waiversPath(config) }
      }

      const { source, targets } = pickEnvironments(config, args)
      const clients = await openContractClients(config, [source, ...targets], exec.signal)

      const facts = new Map()
      for (const key of [source, ...targets]) {
        facts.set(key, await readContractFacts(clients.get(key), exec.signal, {
          includeVisual: args.forms !== false,
        }))
      }

      const upstream = { env: source, facts: facts.get(source) }
      const downstreams = targets.map((key) => ({ env: key, facts: facts.get(key) }))
      const { findings, rows: downstreamRows } = compareContracts(upstream, downstreams, {
        includeManaged: args.includeManaged === true,
      })
      const visualFindings = args.forms === false ? [] : compareVisualContract(upstream, downstreams)

      // Handler judging needs to know which script libraries are project code.
      // The config can pin the list; otherwise infer it from the publishers of
      // the source environment, so the package works against any organization.
      let handlerPrefixes = []
      let handlerPrefixSource = ''
      let handlerFindings = []
      if (args.handlers === true && args.forms !== false) {
        const configured = Array.isArray(config.handlerPrefixes) ? config.handlerPrefixes : []
        handlerPrefixes = configured
        handlerPrefixSource = configured.length ? 'config' : 'publishers'
        if (!configured.length) {
          handlerPrefixes = await detectHandlerPrefixes(clients.get(source), exec.signal)
        }
        handlerFindings = await compareHandlers(clients, downstreams, exec.signal, {
          prefixes: handlerPrefixes,
        })
      }

      let allFindings = [...findings, ...visualFindings, ...handlerFindings]
      if (Array.isArray(args.optionSets) && args.optionSets.length) {
        const optionFindings = await compareOptionValues(
          clients.get(source),
          targets.map((key) => ({ env: key, client: clients.get(key) })),
          args.optionSets,
          exec.signal,
        )
        allFindings = [...findings, ...visualFindings, ...handlerFindings, ...optionFindings]
      }

      const waiverDocument = await readWaivers(config)
      const { kept, waived, expired } = applyWaivers(allFindings, waiverDocument)

      const upstreamIndex = indexContract(upstream.facts)
      const rows = [
        {
          env: source,
          assemblies: upstreamIndex.assemblies.size,
          types: upstreamIndex.types.size,
          steps: upstream.facts.stepsByType.size,
        },
        ...downstreamRows,
      ]

      const history = await readHistory(config)
      const previous = [...history.runs].reverse().find(
        (run) => run.source === source && JSON.stringify(run.targets) === JSON.stringify(targets),
      )
      const currentKeys = kept.map(findingKey)
      const trend = compareWithPrevious(previous, currentKeys)

      const report = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        source,
        targets,
        rows,
        findings: kept,
        waived: waived.length,
        expired: expired.length,
        trend,
        ...(handlerPrefixes.length ? { handlerPrefixes, handlerPrefixSource } : {}),
      }

      const reportPath = await writeContractReport(config, report)
      const markdown = renderContractMarkdown({ ...report, waived: waived.length })
      const { writeFile } = await import('node:fs/promises')
      await writeFile(reportPath.replace(/\.json$/, '.md'), markdown, 'utf8')
      await enforceRetention(config, { target: 'reports' })

      await appendHistory(config, {
        at: report.generatedAt,
        source,
        targets,
        blocker: kept.filter((item) => item.severity === 'blocker').length,
        warning: kept.filter((item) => item.severity !== 'blocker').length,
        waived: waived.length,
        keys: currentKeys,
      })

      return {
        schemaVersion: 1,
        action,
        source,
        targets,
        rows,
        findings: kept,
        waived: waived.length,
        expired: expired.length,
        ...(trend ? { trend } : {}),
        ...(handlerPrefixes.length ? { handlerPrefixes, handlerPrefixSource } : {}),
        reportPath,
        waiversPath: waiversPath(config),
      }
    },
  })
  return dispose
}
