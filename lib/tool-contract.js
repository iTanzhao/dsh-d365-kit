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

const ACTIONS = ['drift', 'matrix', 'waive', 'waivers']

function pickEnvironments(config, args) {
  const keys = Object.keys(config.environments)
  if (!keys.length) throw new D365Error('还没有配置任何 D365 环境', { hint: '在设置页「环境」里添加环境。' })
  const source = args.source ?? config.defaultEnvironment ?? keys[0]
  if (!config.environments[source]) {
    throw new D365Error(`未知环境：${source}`, { hint: `可用：${keys.join(', ')}` })
  }
  const requested = Array.isArray(args.targets) && args.targets.length ? args.targets : keys.filter((key) => key !== source)
  const targets = [...new Set(requested)].filter((key) => key !== source)
  for (const key of targets) {
    if (!config.environments[key]) throw new D365Error(`未知环境：${key}`, { hint: `可用：${keys.join(', ')}` })
  }
  if (!targets.length) throw new D365Error('没有目标环境可比', { hint: '用 targets 指定下游环境，或至少配置两个环境。' })
  return { source, targets }
}

function render(value) {
  const lines = []
  if (value.action === 'waivers') {
    lines.push(`当前豁免 ${value.waivers.length} 条（${value.waiversPath}）`)
    for (const waiver of value.waivers) {
      lines.push(`- ${waiver.rule} · ${waiver.env} · ${waiver.object}${waiver.expiresAt ? ` · 到期 ${waiver.expiresAt}` : ''} — ${waiver.reason}`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }
  if (value.action === 'waive') {
    lines.push(`已记录豁免：${value.waivers.length} 条（${value.waiversPath}）`)
    lines.push('下次漂移检查时，匹配的发现会移入「已豁免」而不是阻断。')
    return [{ type: 'text', text: lines.join('\n') }]
  }

  lines.push(value.action === 'matrix' ? '契约矩阵' : '漂移检查')
  lines.push('')
  lines.push(`上游：${value.source} → 下游：${value.targets.join('、')}`)
  lines.push('')
  lines.push('| 环境 | 程序集 | 插件类型 | 有步骤的类型 |')
  lines.push('| --- | --- | --- | --- |')
  for (const row of value.rows) {
    lines.push(`| ${row.env} | ${row.assemblies} | ${row.types} | ${row.steps} |`)
  }
  lines.push('')

  if (value.handlerPrefixes?.length) {
    const source = value.handlerPrefixSource === 'config' ? '来自配置' : '自动从发布者推断'
    lines.push(`Handler 检查的库前缀：${value.handlerPrefixes.join('、')}（${source}）`)
    lines.push('')
  }
  if (value.trend) {
    lines.push(`对比上次（${value.trend.comparedTo}）：新增 ${value.trend.added.length} 条，已消失 ${value.trend.fixed.length} 条。`)
    lines.push('')
  }
  if (value.waived) {
    lines.push(`已豁免 ${value.waived} 条（.d365/waivers.json）。`)
    if (value.expired) lines.push(`有 ${value.expired} 条豁免已过期：对应的问题重新计入上面的清单，用 d365_contract action=waivers 查看。`)
    lines.push('')
  }

  const blockers = value.findings.filter((item) => item.severity === 'blocker')
  const warnings = value.findings.filter((item) => item.severity !== 'blocker')
  const section = (title, items, limit) => {
    lines.push(`### ${title} ${items.length}`)
    if (!items.length) {
      lines.push('无。')
    } else {
      for (const item of items.slice(0, limit)) {
        lines.push(`- [${item.env}] ${item.message}${item.evidence ? ` — ${item.evidence}` : ''}`)
      }
      if (items.length > limit) lines.push(`- … 其余 ${items.length - limit} 条见报告`)
    }
    lines.push('')
  }
  section('阻断', blockers, 15)
  section('警告', warnings, 15)
  if (value.waived) {
    lines.push(`已豁免 ${value.waived} 条（见 ${value.waiversPath}）。`)
    if (value.expired) lines.push(`其中 ${value.expired} 条豁免已过期。`)
    lines.push('')
  }
  lines.push(`报告：${value.reportPath}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

export function register(ctx, state) {
  const dispose = ctx.tools.register({
    name: 'd365_contract',
    description:
      '契约矩阵与漂移：把上游环境的插件注册（程序集/类型/步骤）当作契约，检查下游缺了什么、版本是不是更旧，可选比对全局选项集的值；支持记录豁免与对比上次运行。只读（waive 会写本机 waivers.json）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'drift：跑规则找漂移（默认）；matrix：只看规模；waive：记录豁免；waivers：列豁免。',
        },
        source: { type: 'string', description: '上游环境 key，默认取配置的默认环境。' },
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: '下游环境 key 列表，省略表示除上游外的全部环境。',
        },
        optionSets: {
          type: 'array',
          items: { type: 'string' },
          description: '要逐值比对的全局选项集名称，例如 ["contoso_taxcategoryos"]。',
        },
        includeManaged: {
          type: 'boolean',
          description: '默认只看上游未受管的程序集；设为 true 连受管的一起比（噪声大）。',
        },
        forms: {
          type: 'boolean',
          description: '默认检查表单引用的 Web 资源与站点地图；设为 false 跳过（省掉读 formxml 的开销）。',
        },
        handlers: {
          type: 'boolean',
          description: '设为 true 时额外下载脚本内容，核对表单 Handler 指向的函数是否真的存在（较慢，每个环境最多 400 个脚本）。',
        },
        rule: { type: 'string', enum: RULES.map((rule) => rule.id), description: 'waive：豁免哪条规则。' },
        env: { type: 'string', description: 'waive：豁免哪个环境，* 表示全部。' },
        object: { type: 'string', description: 'waive：豁免哪个对象（类型名/程序集名/选项集名），支持前缀 *。' },
        reason: { type: 'string', description: 'waive：为什么接受这个差异（必填）。' },
        days: { type: 'number', description: 'waive：多少天后过期，默认 30。' },
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
        if (!args.rule) throw new D365Error('waive 需要 rule', { hint: `可用：${RULES.map((rule) => rule.id).join(', ')}` })
        if (!args.env) throw new D365Error('waive 需要 env', { hint: '指定环境 key，或 * 表示全部。' })
        if (!args.object) throw new D365Error('waive 需要 object', { hint: '类型名、程序集名或选项集名；支持前缀 *。' })
        if (!args.reason || !String(args.reason).trim()) {
          throw new D365Error('waive 需要 reason', { hint: '写清楚为什么接受这个差异，半年后有人会看。' })
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
