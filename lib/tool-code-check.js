/**
 * `d365_code_check` — what does this merge request break in a target environment?
 *
 * Only the files the MR touches are analyzed, and only their added/removed
 * lines: the question is "will this change run elsewhere", not "is this
 * repository clean".
 */
import { loadConfig } from './config.js'
import { runCodeCheck } from './code-check.js'

export const definition = {
  name: 'd365_code_check',
  description:
    '检查一次 GitLab MR 的改动在目标环境会不会跑不起来：JS/TS 映射到 Web 资源与表单，核对改动行读取的字段/实体是否还在表单上；'
    + 'C# 映射到插件程序集，核对程序集版本、插件类型、步骤、step 镜像与过滤属性。无法静态判定的进人工确认清单。只读。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['mergeRequest'],
    properties: {
      mergeRequest: {
        type: 'string',
        description: 'MR 链接（https://gitlab…/group/project/-/merge_requests/42），或 IID（42 / !42）。',
      },
      project: {
        type: 'string',
        description: 'GitLab 项目路径 group/project；省略时用 MR 链接里的项目，再省略用设置页的默认项目。',
      },
      targets: {
        type: 'array',
        items: { type: 'string' },
        description: '要对照检查的环境 key 列表；省略则全部环境。',
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
  lines.push(`代码改动检查：MR !${report.iid}${report.title ? ` · ${report.title}` : ''}`)
  lines.push(`项目：${report.project}`)
  if (report.sourceBranch) lines.push(`分支：${report.sourceBranch} → ${report.targetBranch}`)
  lines.push(`目标环境：${report.targets.join('、')}`)
  lines.push('')

  lines.push('| 改动文件 | 类型 | 增/删行 | 检查到的引用 |')
  lines.push('| --- | --- | --- | --- |')
  for (const file of report.files) {
    const refs = file.references
      ? `字段 ${file.references.attributes.length} · 实体 ${file.references.entities.length} · GUID ${file.references.guids.length}`
      : file.facts
        ? `类 ${file.facts.classes.length} · 镜像 ${file.facts.images.length} · 字面量 ${file.facts.literals.length}`
        : '—'
    lines.push(`| ${file.path} | ${file.kind} | +${file.addedLines ?? 0}/-${file.removedLines ?? 0} | ${refs} |`)
  }

  for (const file of report.files) {
    if (!file.targets?.length) continue
    lines.push('')
    lines.push(`### ${file.path}`)
    for (const target of file.targets) {
      if (file.kind === 'csharp') {
        const types = target.types?.length ?? 0
        const steps = (target.types ?? []).reduce((sum, item) => sum + (item.steps?.length ?? 0), 0)
        const mapped = target.assembly
          ? `程序集 ${target.assembly}（${target.version ?? '版本未知'}${target.certain ? '' : '，推断待确认'}），类型 ${types}，步骤 ${steps}`
          : '未匹配到程序集'
        lines.push(`- ${target.target}：${mapped}`)
        continue
      }
      const forms = target.forms?.length ?? 0
      const mapped = target.resourceName
        ? `→ ${target.resourceName}${target.certain ? '' : '（推断，待确认）'}，${forms} 张表单引用`
        : '→ 未找到对应 Web 资源'
      lines.push(`- ${target.target}：${mapped}`)
    }
  }

  const blockers = report.findings.filter((item) => item.severity === 'blocker')
  const warnings = report.findings.filter((item) => item.severity === 'warning')

  lines.push('')
  lines.push(`### 阻断项 ${blockers.length}`)
  if (!blockers.length) lines.push('没有发现必然失败的改动。')
  for (const item of blockers) {
    lines.push(`- [${item.target}] ${item.file}${item.line ? `:${item.line}` : ''} — ${item.message}`)
  }

  lines.push('')
  lines.push(`### 警告 ${warnings.length}`)
  if (!warnings.length) lines.push('没有警告。')
  for (const item of warnings) {
    lines.push(`- [${item.target}] ${item.file}${item.line ? `:${item.line}` : ''} — ${item.message}`)
  }

  lines.push('')
  lines.push(`### 人工确认 ${report.human.length}`)
  if (!report.human.length) lines.push('没有需要人工确认的条目。')
  for (const item of report.human) {
    lines.push(`- ${item.id} ${item.object}：${item.question}`)
    lines.push(`  证据：${item.evidence}`)
    lines.push(`  确认：${item.howToCheck}`)
    lines.push(`  影响：${item.impact}`)
  }

  lines.push('')
  lines.push(`报告：${reportPath}`)
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
