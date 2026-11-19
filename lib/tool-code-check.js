/**
 * `d365_code_check` — what does this merge request break in a target environment?
 *
 * Only the files the MR touches are analyzed, and only their added/removed
 * lines: the question is "will this change run elsewhere", not "is this
 * repository clean".
 */
import { loadConfig } from './config.js'
import { runCodeCheck } from './code-check.js'
import { t } from './i18n.js'

export const definition = {
  name: 'd365_code_check',
  description:
    'Check whether a GitLab merge request will work in target Dataverse environments. Read-only; maps JS/TS changes to web resources and forms, '
    + 'and C# changes to plug-in registrations; returns manual-confirmation items for checks that cannot be completed statically.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['mergeRequest'],
    properties: {
      mergeRequest: {
        type: 'string',
        description: 'Merge-request URL, such as https://gitlab.example/group/project/-/merge_requests/42, or IID (42 / !42).',
      },
      project: {
        type: 'string',
        description: 'GitLab project path group/project; otherwise use the MR project, then the configured default project.',
      },
      targets: {
        type: 'array',
        items: { type: 'string' },
        description: 'Environment keys to check against; defaults to all configured environments.',
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

function renderReport(report, reportPath) {
  const lines = []
  lines.push(t('toolCode.heading', { iid: report.iid, title: report.title ? ' · ' + report.title : '' }))
  lines.push(t('toolCode.project', { project: report.project }))
  if (report.sourceBranch) lines.push(t('toolCode.branch', { source: report.sourceBranch, target: report.targetBranch }))
  lines.push(t('toolCode.targets', { targets: report.targets.join(', ') }), '', t('toolCode.fileTableHeader'), t('toolCode.fileTableDivider'))
  for (const file of report.files) {
    const refs = file.references
      ? t('toolCode.refs', { attributes: file.references.attributes.length, entities: file.references.entities.length, guids: file.references.guids.length })
      : file.facts
        ? t('toolCode.facts', { classes: file.facts.classes.length, images: file.facts.images.length, literals: file.facts.literals.length })
        : '—'
    lines.push(t('toolCode.fileRow', { path: file.path, kind: file.kind, status: file.unverified ? t('toolCode.unverifiedMark') : '', added: file.addedLines ?? 0, removed: file.removedLines ?? 0, refs }))
  }
  for (const file of report.files) {
    if (!file.targets?.length) continue
    lines.push('', '### ' + file.path)
    for (const target of file.targets) {
      if (file.kind === 'csharp') {
        const types = target.types?.length ?? 0
        const steps = (target.types ?? []).reduce((sum, item) => sum + (item.steps?.length ?? 0), 0)
        const mapped = target.assembly
          ? t('toolCode.csharpMapped', { assembly: target.assembly, version: target.version ?? t('toolCode.versionUnknown'), certainty: target.certain ? '' : t('toolCode.inferred'), types, steps })
          : t('toolCode.assemblyMissing')
        lines.push(t('toolCode.targetLine', { target: target.target, mapped })); continue
      }
      const forms = target.forms?.length ?? 0
      const mapped = target.resourceName
        ? t('toolCode.webMapped', { resource: target.resourceName, certainty: target.certain ? '' : t('toolCode.inferred'), forms })
        : t('toolCode.webMissing')
      lines.push(t('toolCode.targetLine', { target: target.target, mapped }))
    }
  }
  const unverified = report.files.filter((file) => file.unverified)
  const blockers = report.findings.filter((item) => item.severity === 'blocker')
  const warnings = report.findings.filter((item) => item.severity === 'warning')
  if (unverified.length) {
    lines.push('', t('toolCode.unverifiedHeading', { count: unverified.length }))
    for (const file of unverified) lines.push('- ' + file.path + ' — ' + file.unverified)
  }
  lines.push('', t('toolCode.blockersHeading', { count: blockers.length }))
  if (!blockers.length) lines.push(unverified.length ? t('toolCode.noBlockersUnverified', { count: unverified.length }) : t('toolCode.noBlockers'))
  for (const item of blockers) lines.push('- [' + item.target + '] ' + item.file + (item.line ? ':' + item.line : '') + ' — ' + item.message)
  lines.push('', t('toolCode.warningsHeading', { count: warnings.length }))
  if (!warnings.length) lines.push(t('toolCode.noWarnings'))
  for (const item of warnings) lines.push('- [' + item.target + '] ' + item.file + (item.line ? ':' + item.line : '') + ' — ' + item.message)
  lines.push('', t('toolCode.humanHeading', { count: report.human.length }))
  if (!report.human.length) lines.push(t('toolCode.noHuman'))
  for (const item of report.human) lines.push('- ' + item.id + ' ' + item.object + ': ' + item.question, t('toolCode.evidence', { text: item.evidence }), t('toolCode.confirm', { text: item.howToCheck }), t('toolCode.impact', { text: item.impact }))
  lines.push('', t('toolCode.reportPath', { path: reportPath }))
  return lines.join('\n')
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args, exec) {
      const config = await loadConfig(state.rawConfig)
      const { report, reportPath } = await runCodeCheck(config, args ?? {}, exec?.signal)
      return { text: renderReport(report, reportPath) }
    },
  })
}
