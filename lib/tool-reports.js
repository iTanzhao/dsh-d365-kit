/**
 * `d365_reports` — one place to see what the other tools produced, how much
 * space `.d365` is using, and to apply the retention policy by hand.
 *
 * Cleanup always plans first (`dryRun` defaults to true) and never touches
 * waivers, pending plans, config or secrets.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { loadConfig } from './config.js'
import { D365Error } from './errors.js'
import { dataRoot } from './snapshot.js'
import { readHistory } from './contract-history.js'
import { readWaivers } from './waivers.js'
import {
  applyCleanup, compactAllSnapshots, formatBytes, planCleanup, storageSummary,
} from './retention.js'

const CLASS_IDS = ['snapshots', 'reports', 'diffs', 'query', 'changes', 'all']

async function listFiles(directory, limit) {
  let names = []
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const rows = []
  for (const name of names) {
    try {
      const info = await stat(join(directory, name))
      if (!info.isFile()) continue
      rows.push({ name, size: info.size, modifiedAt: info.mtime.toISOString() })
    } catch {
      // A file that vanished between readdir and stat is simply not listed.
    }
  }
  rows.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  return rows.slice(0, limit)
}

const VIEW_DEFAULT_LIMIT = 60
const VIEW_MAX_LIMIT = 2000
const VIEW_WRAP_DEFAULT = 400

/** @returns true when `file` stays inside `root` (no `..` escape, no absolute jump). */
function insideRoot(root, file) {
  const rel = relative(root, file)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Locate an artifact the model asked to read.
 *
 * Only files under `.d365` are reachable: an absolute path that points
 * elsewhere is refused rather than silently read, because the tool's contract
 * is "show me what this plugin wrote", not "read any file".
 * @returns `{ file, size }`
 */
async function resolveArtifact(config, name) {
  const wanted = String(name ?? '').trim()
  if (!wanted) {
    throw new D365Error('view 需要 file', {
      hint: '先用 action=list 看有哪些产物；file 可以是 .d365 下的相对路径（如 query/xxx.json）或文件名。',
    })
  }
  const root = resolve(dataRoot(config))
  const candidates = isAbsolute(wanted)
    ? [resolve(wanted)]
    : [resolve(root, wanted), ...['query', 'reports', 'diffs', 'changes'].map((dir) => resolve(root, dir, wanted))]
  for (const candidate of candidates) {
    if (!insideRoot(root, candidate)) continue
    try {
      const info = await stat(candidate)
      if (info.isFile()) return { file: candidate, size: info.size }
    } catch {
      // Not here; the next candidate may be.
    }
  }
  throw new D365Error(`找不到产物：${wanted}`, {
    code: 'artifact-not-found',
    hint: '只在 .d365 目录里查找。用 action=list 看现有文件；绝对路径也必须落在这个目录内。',
  })
}

/**
 * Render a window of one artifact.
 *
 * JSON written by the query tools is one very long line, so it is expanded by
 * default; `match` narrows to the lines that mention a string, which is the
 * only practical way to find one GUID in a 500 KB result.
 */
async function renderView(config, args) {
  const { file, size } = await resolveArtifact(config, args.file)
  const raw = await readFile(file, 'utf8')
  const isJson = file.toLowerCase().endsWith('.json')
  const pretty = args.pretty ?? isJson
  let text = raw
  if (pretty && isJson) {
    try {
      text = JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      // Malformed or truncated JSON: show what is on disk instead of failing.
    }
  }

  const allLines = text.split(/\r?\n/)
  const match = String(args.match ?? '').trim()
  const numbered = allLines.map((line, index) => ({ line, number: index + 1 }))
  const filtered = match
    ? numbered.filter((item) => item.line.toLowerCase().includes(match.toLowerCase()))
    : numbered

  const offset = Number.isFinite(args.offset) && args.offset > 0 ? Math.floor(args.offset) : 0
  const limit = Math.min(Math.max(Number.isFinite(args.limit) ? Math.floor(args.limit) : VIEW_DEFAULT_LIMIT, 1), VIEW_MAX_LIMIT)
  const wrap = args.wrap === 0 ? 0 : Math.min(Math.max(Number.isFinite(args.wrap) ? Math.floor(args.wrap) : VIEW_WRAP_DEFAULT, 40), 4000)
  const window = filtered.slice(offset, offset + limit)

  const header = [
    `文件：${file}`,
    `大小：${formatBytes(size)} · 行数：${allLines.length}${pretty && isJson ? '（JSON 已展开）' : ''}${match ? ` · 匹配 "${match}"：${filtered.length} 行` : ''}`,
  ]
  const shownTo = offset + window.length
  const remaining = filtered.length - shownTo
  header.push(`第 ${offset + 1}–${shownTo} 行${remaining > 0 ? `（还有 ${remaining} 行，调 offset: ${shownTo} 继续）` : ''}`)

  const body = []
  for (const item of window) {
    const pieces = wrap > 0 ? item.line.match(new RegExp(`[\\s\\S]{1,${wrap}}`, 'g')) ?? [''] : [item.line]
    body.push(`${String(item.number).padStart(6)}│ ${pieces[0]}`)
    for (const piece of pieces.slice(1)) body.push(`${' '.repeat(6)}│ ${piece}`)
  }
  if (!window.length) body.push(match ? '（没有匹配的行）' : '（文件为空）')

  return { text: [...header, '', ...body].join('\n'), file }
}

function storageLines(summary) {
  const lines = [`占用合计：${formatBytes(summary.totalBytes)}${summary.overLimit ? `（超过 ${summary.warnMegabytes} MB，建议清理）` : ''}`, '']
  for (const row of summary.classes) {
    lines.push(`- ${row.label}（${row.id}）：${row.count} 个 · ${formatBytes(row.bytes)} · 保留 ${row.keep} 个 / ${row.maxAgeDays} 天${row.hint ? ` · ${row.hint}` : ''}`)
  }
  return lines
}

function planLines(plan) {
  const lines = [`将删除 ${plan.totalFiles} 个文件，释放 ${formatBytes(plan.totalBytes)}`, '']
  for (const row of plan.classes) {
    if (!row.remove.length) {
      lines.push(`- ${row.label}：无需清理（${row.count} 个，保留 ${row.keep} 个 / ${row.maxAgeDays} 天）`)
      continue
    }
    lines.push(`- ${row.label}：删除 ${row.remove.length} 个 · ${formatBytes(row.bytes)}`)
    for (const item of row.remove.slice(0, 5)) {
      lines.push(`  · ${item.name}（${item.ageDays} 天前，${formatBytes(item.bytes)}）`)
    }
    if (row.remove.length > 5) lines.push(`  · … 其余 ${row.remove.length - 5} 个`)
  }
  return lines
}

export function register(ctx, state) {
  const dispose = ctx.tools.register({
    name: 'd365_reports',
    description:
      '查看本机数据占用与产物（.d365/reports、query 等），并按保留策略清理或压缩历史产物。cleanup 默认只预演（dryRun），确认后传 dryRun=false 才真正删除。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'cleanup', 'compact', 'view'],
          description: 'list：看占用与产物；view：读回一个产物文件（分页/过滤）；cleanup：按策略清理；compact：把已有快照压成紧凑 JSON。默认 list。',
        },
        file: {
          type: 'string',
          description: 'view 的文件：.d365 下的相对路径（如 query/2026-11-06T01-36-47-274Z-layers.json）或文件名。',
        },
        offset: { type: 'number', description: 'view 从第几行开始（0 基），默认 0。' },
        match: { type: 'string', description: 'view 只显示包含这个字符串的行（不区分大小写）。在大 JSON 里找一条 GUID 用这个。' },
        wrap: { type: 'number', description: 'view 每行最多多少字符，超长折行；0 表示不折行。默认 400。' },
        pretty: { type: 'boolean', description: 'view 是否把 JSON 缩进展开，默认对 .json 为 true。' },
        target: {
          type: 'string',
          enum: CLASS_IDS,
          description: 'cleanup 的范围：某一类或 all，默认 all。',
        },
        dryRun: {
          type: 'boolean',
          description: 'cleanup 默认 true，只预演不删除；确认要删时传 false。',
        },
        limit: { type: 'number', description: 'list 每类最多列多少条，默认 15。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['schemaVersion', 'action', 'text'],
        properties: {
          schemaVersion: { type: 'number' },
          action: { type: 'string' },
          text: { type: 'string' },
        },
      },
      render: (args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const config = await loadConfig(state.rawConfig)
      const action = args.action ?? 'list'

      if (action === 'view') {
        const view = await renderView(config, args)
        return { schemaVersion: 1, action, text: view.text }
      }

      if (action === 'compact') {
        const result = await compactAllSnapshots(config)
        const summary = await storageSummary(config)
        const lines = [
          `已压缩 ${result.snapshots} 份快照里的 ${result.files} 个文件，释放 ${formatBytes(result.savedBytes)}。`,
          '',
          ...storageLines(summary),
        ]
        return { schemaVersion: 1, action, text: lines.join('\n') }
      }

      if (action === 'cleanup') {
        const target = CLASS_IDS.includes(args.target) ? args.target : 'all'
        const dryRun = args.dryRun !== false
        const plan = await planCleanup(config, { target })
        if (dryRun) {
          const lines = [`清理预演（${target}）：尚未删除任何文件。`, '', ...planLines(plan)]
          lines.push('', '确认要删除时，把 dryRun 设为 false 再调用一次。')
          return { schemaVersion: 1, action, text: lines.join('\n') }
        }
        const applied = await applyCleanup(config, plan)
        const summary = await storageSummary(config)
        const lines = [
          `已删除 ${applied.deleted.length} 个文件，释放 ${formatBytes(applied.bytes)}。`,
          ...(applied.failures.length ? ['', `失败 ${applied.failures.length} 个：`, ...applied.failures.map((item) => `- ${item.name}：${item.reason}`)] : []),
          '',
          ...storageLines(summary),
        ]
        return { schemaVersion: 1, action, text: lines.join('\n') }
      }

      const limit = Number.isFinite(args.limit) ? Math.min(Math.max(args.limit, 1), 100) : 15
      const root = dataRoot(config)
      const reports = await listFiles(join(root, 'reports'), limit)
      const queries = await listFiles(join(root, 'query'), limit)
      const summary = await storageSummary(config)

      let waiverCount = 0
      try {
        const document = await readWaivers(config)
        waiverCount = (document.waivers ?? []).length
      } catch {
        waiverCount = 0
      }
      let lastContractRun = ''
      try {
        const history = await readHistory(config)
        const last = history.runs?.[history.runs.length - 1]
        if (last) {
          lastContractRun = `${last.at}（${last.source} → ${(last.targets ?? []).join(', ')}，阻断 ${last.blocker ?? 0} / 警告 ${last.warning ?? 0}，豁免 ${last.waived ?? 0}）`
        }
      } catch {
        lastContractRun = ''
      }

      const lines = ['本机数据', '', ...storageLines(summary), '']
      // Totals come from the storage summary, not from the truncated listing:
      // "25 个" next to three bullets looked like a bug.
      const classCount = (id) => summary.classes.find((item) => item.id === id)?.count ?? 0
      const reportTotal = classCount('reports')
      lines.push(`报告（.d365/reports）：${reportTotal} 个${reportTotal > reports.length ? `，下面是最近 ${reports.length} 个` : ''}`)
      for (const row of reports) {
        lines.push(`- ${row.name} · ${(row.size / 1024).toFixed(1)} KB · ${row.modifiedAt}`)
      }
      lines.push('')
      const queryTotal = classCount('query')
      const shownQueries = queries.slice(0, 8)
      lines.push(`查询留证（.d365/query）：${queryTotal} 个${queryTotal > shownQueries.length ? `，下面是最近 ${shownQueries.length} 个` : ''}`)
      for (const row of shownQueries) {
        lines.push(`- ${row.name} · ${(row.size / 1024).toFixed(1)} KB`)
      }
      lines.push('')
      lines.push(`已登记豁免：${waiverCount} 条`)
      lines.push(`最近一次契约检查：${lastContractRun || '还没有跑过'}`)
      lines.push('')
      lines.push('要读回某个产物（而不是只看文件名），用 action=view 加 file；大文件配 match 过滤、offset/limit 翻页。')
      return { schemaVersion: 1, action: 'list', text: lines.join('\n') }
    },
  })
  return dispose
}
