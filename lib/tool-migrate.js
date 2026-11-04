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

export const definition = {
  name: 'd365_migrate',
  description:
    '评估把某个解决方案从源环境发布到其它环境的迁移风险：目标是否已有该解决方案、每个组件在目标环境的层会被谁覆盖、'
    + '选项集会不会丢值。只读，不会修改任何环境。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['solution'],
    properties: {
      action: {
        type: 'string',
        enum: ['assess'],
        description: '评估动作，目前只有 assess。默认 assess。',
      },
      source: {
        type: 'string',
        description: '源环境 key，例如 dev。省略则用默认环境。',
      },
      solution: {
        type: 'string',
        description: '要评估的解决方案唯一名，例如 ContosoBase。',
      },
      targets: {
        type: 'array',
        items: { type: 'string' },
        description: '目标环境 key 列表，例如 ["sit","uat"]。省略则除源环境外的全部环境。',
      },
      maxComponents: {
        type: 'integer',
        description: '最多评估多少个组件，默认 150。单组件层查询约 1.8 秒，并发 4 时约 70 秒。',
      },
      full: {
        type: 'boolean',
        description: '忽略 maxComponents，评估全部组件（364 个组件约 3 分钟）。',
      },
      concurrency: {
        type: 'integer',
        description: '并发请求数，默认 4，最大 8。调高会更快，也更容易触发服务保护。',
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
  lines.push(`迁移评估：${result.solution}（${result.source.label}）`)
  lines.push(
    `组件 ${result.componentCount} 个，本次评估 ${result.evaluated} 个`
    + (result.truncated ? `（超过 maxComponents=${result.maxComponents}，传 full: true 可全量评估）` : ''),
  )
  lines.push('')
  lines.push('| 目标环境 | 严重 | 警告 | 目标缺失组件 | 会被遮蔽的解决方案 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const report of result.reports) {
    lines.push(`| ${report.targetLabel} | ${report.critical} | ${report.warnings} | ${report.missing} | ${report.shadowed} |`)
  }
  for (const report of result.reports) {
    lines.push('')
    lines.push(`### ${report.targetLabel}`)
    lines.push(report.verdict.summary)
    if (report.verdict.recommendation) lines.push(`建议：${report.verdict.recommendation}`)
    lines.push(`报告：${report.reportPath}`)
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
