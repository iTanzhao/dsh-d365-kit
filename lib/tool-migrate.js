/**
 * `d365_migrate` — will this solution zip hurt when imported elsewhere?
 *
 * Importing a solution silently stacks a new layer on every component it
 * contains, and stacking order is decided by import time, not by version. This
 * tool answers the questions a release engineer actually asks before pressing
 * import: does the target have this solution, which solutions' definitions will
 * be hidden underneath, and will any option-set values disappear.
 */
import { loadConfig } from './config.js'
import { assessMigration } from './migrate.js'
import { t } from './i18n.js'

export const definition = {
  name: 'd365_migrate',
  description:
    'Assess whether publishing a solution to other environments would shadow layers or lose option values. '
    + 'Read-only; use d365_data_sync to move records and d365_metadata_write to change metadata.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['solution'],
    properties: {
      action: {
        type: 'string',
        enum: ['assess'],
        description: 'Assessment action; currently only assess. Defaults to assess.',
      },
      source: {
        type: 'string',
        description: 'Source environment key such as dev; uses the default when omitted.',
      },
      solution: {
        type: 'string',
        description: 'Unique name of the solution to assess, such as ContosoBase.',
      },
      targets: {
        type: 'array',
        items: { type: 'string' },
        description: 'Target environment keys such as ["sit","uat"]; defaults to all environments except the source.',
      },
      maxComponents: {
        type: 'integer',
        description: 'Maximum components to assess, default 150. A component layer query takes about 1.8 seconds; 150 at concurrency 4 takes about 70 seconds.',
      },
      full: {
        type: 'boolean',
        description: 'Ignore maxComponents and assess every component (364 components take about 3 minutes).',
      },
      concurrency: {
        type: 'integer',
        description: 'Concurrent requests, default 4, maximum 8. Higher values are faster but increase service-protection risk.',
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

function renderResult(result) {
  const lines = []
  lines.push(t('toolMigrate.heading', { solution: result.solution, source: result.source.label }))
  lines.push(t('toolMigrate.scope', { total: result.componentCount, evaluated: result.evaluated })
    + (result.truncated ? t('toolMigrate.truncated', { max: result.maxComponents }) : ''))
  lines.push('')
  lines.push(t('toolMigrate.tableHeader'), '| --- | --- | --- | --- | --- | --- |')
  for (const report of result.reports) lines.push(t('toolMigrate.tableRow', { target: report.targetLabel, critical: report.critical, warnings: report.warnings, unresolved: report.unresolved ?? 0, missing: report.missing, shadowed: report.shadowed }))
  for (const report of result.reports) {
    lines.push('', t('toolMigrate.targetHeading', { target: report.targetLabel }), report.verdict.summary)
    if (report.verdict.recommendation) lines.push(t('toolMigrate.recommendation', { text: report.verdict.recommendation }))
    lines.push(t('toolMigrate.reportPath', { path: report.reportPath }))
  }
  return lines.join('\n')
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args, exec) {
      const config = await loadConfig(state.rawConfig)
      const result = await assessMigration(config, args ?? {}, exec?.signal)
      return { text: renderResult(result) }
    },
  })
}
