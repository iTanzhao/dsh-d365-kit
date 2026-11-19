/**
 * `d365_reports` — one place to see what the other tools produced, how much
 * space `.d365` is using, and to apply the retention policy by hand.
 *
 * Cleanup always plans first (`dryRun` defaults to true) and never touches
 * waivers, pending plans, config or secrets.
 */

import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { loadConfig } from './config.js'
import { D365Error } from './errors.js'
import { t } from './i18n.js'
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
/** JSON is only expanded in memory up to this size; bigger files are streamed. */
const JSON_EXPAND_MAX_BYTES = 8 * 1024 * 1024
/** Longest line kept in memory while scanning; one artifact line can be huge. */
const VIEW_LINE_CAP = 4096
const VIEW_CHUNK = 256 * 1024

/**
 * Walk a file line by line while holding at most one chunk and one capped line.
 *
 * `readline` is not enough here: an artifact can put a 1 GB
 * `msdyn_componentjson` value on a single line, and `readline` would materialize
 * that line as one string. Lines longer than `cap` are cut, and the dropped
 * character count is reported so the view can say how much it did not show.
 * @yields `{ text, dropped }`
 */
export async function* scanLines(file, cap = VIEW_LINE_CAP, argumentsPattern = '') {
  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: VIEW_CHUNK })
  let pending = ''
  let dropped = 0
  let matchTail = ''
  let matched = false
  const add = (part) => {
    if (argumentsPattern && !matched) {
      const combined = matchTail + part.toLowerCase()
      matched = combined.includes(argumentsPattern)
      matchTail = combined.slice(-(argumentsPattern.length - 1 || 0))
    }
    if (pending.length < cap) {
      const room = cap - pending.length
      pending += part.slice(0, room)
      dropped += Math.max(0, part.length - room)
    } else {
      dropped += part.length
    }
  }
  const take = () => {
    const text = pending.endsWith('\r') ? pending.slice(0, -1) : pending
    const item = { text, dropped, matched }
    pending = ''
    dropped = 0
    matchTail = ''
    matched = false
    return item
  }
  for await (const chunk of stream) {
    let start = 0
    let nl = chunk.indexOf('\n')
    while (nl !== -1) {
      add(chunk.slice(start, nl))
      yield take()
      start = nl + 1
      nl = chunk.indexOf('\n', start)
    }
    if (start < chunk.length) add(chunk.slice(start))
  }
  // A trailing newline ends the last line; it does not start an empty one.
  if (pending.length > 0) yield take()
}

/** @yields the lines of an already-in-memory text. */
async function* linesOf(text) {
  for (const line of text.split(/\r?\n/)) yield { text: line, dropped: 0 }
}

/**
 * Render a window of one artifact.
 *
 * JSON is expanded by default, but only from a bounded read: the file is
 * streamed line by line for everything bigger, so asking for page N never
 * materializes a 1 GB `msdyn_componentjson` payload. `match` narrows to the
 * lines that mention a string, which is the only practical way to find one
 * GUID in a 500 KB result.
 */
export async function renderView(config, args) {
  const { file, size } = await resolveArtifact(config, args.file)
  const isJson = file.toLowerCase().endsWith('.json')
  const pretty = args.pretty ?? isJson
  const match = String(args.match ?? '').trim()
  const needle = match.toLowerCase()
  const offset = Number.isFinite(args.offset) && args.offset > 0 ? Math.floor(args.offset) : 0
  const limit = Math.min(Math.max(Number.isFinite(args.limit) ? Math.floor(args.limit) : VIEW_DEFAULT_LIMIT, 1), VIEW_MAX_LIMIT)
  const wrap = args.wrap === 0 ? 0 : Math.min(Math.max(Number.isFinite(args.wrap) ? Math.floor(args.wrap) : VIEW_WRAP_DEFAULT, 40), 4000)

  const expandable = pretty && isJson
  const tooLarge = expandable && size > JSON_EXPAND_MAX_BYTES
  let expandedText
  let expanded = false
  if (expandable && !tooLarge) {
    try {
      expandedText = JSON.stringify(JSON.parse(await readFile(file, 'utf8')), null, 2)
      expanded = true
    } catch {
      // Malformed or truncated JSON: stream what is on disk instead of failing.
    }
  }

  const source = expandedText === undefined ? scanLines(file, VIEW_LINE_CAP, needle) : linesOf(expandedText)
  const window = []
  let total = 0
  let matched = 0
  let truncated = 0
  for await (const item of source) {
    total += 1
    if (item.dropped) truncated += 1
    if (needle && !(item.matched ?? item.text.toLowerCase().includes(needle))) continue
    matched += 1
    if (matched > offset && window.length < limit) {
      window.push({ ...item, number: total })
    }
  }
  const filteredCount = needle ? matched : total

  const jsonNote = !expandable
    ? ''
    : expanded
      ? t('reports.jsonExpanded')
      : tooLarge
        ? t('reports.jsonLarge')
        : t('reports.jsonRaw')
  const header = [
    t('reports.file', { file }),
    t('reports.sizeLines', { size: formatBytes(size), total, note: jsonNote + (truncated ? t('reports.longLines', { count: truncated }) : '') + (match ? t('reports.matches', { match, count: filteredCount }) : '') }),
  ]
  const shownTo = offset + window.length
  const remaining = filteredCount - shownTo
  header.push(t('reports.lineWindow', { from: offset + 1, to: shownTo, rest: remaining > 0 ? t('reports.remaining', { count: remaining, offset: shownTo }) : '' }))

  const body = []
  for (const item of window) {
    const pieces = wrap > 0 ? item.text.match(new RegExp(`[\\s\\S]{1,${wrap}}`, 'g')) ?? [''] : [item.text]
    body.push(`${String(item.number).padStart(6)}│ ${pieces[0]}`)
    for (const piece of pieces.slice(1)) body.push(`${' '.repeat(6)}│ ${piece}`)
    if (item.dropped) body.push(`${' '.repeat(6)}│ ${t('reports.omitted', { count: item.dropped, cap: VIEW_LINE_CAP })}`)
  }
  if (!window.length) body.push(match ? t('reports.noMatches') : t('reports.emptyFile'))

  return { text: [...header, '', ...body].join('\n'), file }
}

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
    throw new D365Error('view requires file', { i18nKey: 'reports.fileRequired', hintKey: 'reports.fileRequiredHint' })
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
  throw new D365Error(`Artifact not found: ${wanted}`, { code: 'artifact-not-found', i18nParams: { file: wanted }, i18nKey: 'reports.notFound', hintKey: 'reports.notFoundHint' })
}

function storageLines(summary) {
  const lines = [t('reports.totalStorage', { size: formatBytes(summary.totalBytes), warning: summary.overLimit ? t('reports.overLimit', { mb: summary.warnMegabytes }) : '' }), '']
  for (const row of summary.classes) {
    lines.push(t('reports.storageRow', { label: row.label, id: row.id, count: row.count, size: formatBytes(row.bytes), keep: row.keep, days: row.maxAgeDays, hint: row.hint ? ` · ${row.hint}` : '' }))
  }
  return lines
}

function planLines(plan) {
  const lines = [t('reports.willDelete', { files: plan.totalFiles, size: formatBytes(plan.totalBytes) }), '']
  for (const row of plan.classes) {
    if (!row.remove.length) {
      lines.push(t('reports.nothingToClean', { label: row.label, count: row.count, keep: row.keep, days: row.maxAgeDays }))
      continue
    }
    lines.push(t('reports.deleteRow', { label: row.label, count: row.remove.length, size: formatBytes(row.bytes) }))
    for (const item of row.remove.slice(0, 5)) {
      lines.push(t('reports.oldFile', { name: item.name, days: item.ageDays, size: formatBytes(item.bytes) }))
    }
    if (row.remove.length > 5) lines.push(t('reports.moreFiles', { count: row.remove.length - 5 }))
  }
  return lines
}

export function register(ctx, state) {
  const dispose = ctx.tools.register({
    name: 'd365_reports',
    description:
      'Inspect local storage and artifacts (.d365/reports, query, and others), then preview cleanup or compact snapshots according to retention policy. '
      + 'cleanup defaults to a dry run; pass dryRun=false only after confirming deletion. This tool reads local artifacts; rerun queries, checks, or snapshots with their dedicated tools.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'cleanup', 'compact', 'view'],
          description: 'list shows usage and artifacts; view reads an artifact with paging/filtering; cleanup applies retention; compact rewrites snapshots. Defaults to list.',
        },
        file: {
          type: 'string',
          description: 'For view: relative .d365 path or filename.',
        },
        offset: { type: 'number', description: 'For view: starting line, zero-based, default 0.' },
        match: { type: 'string', description: 'For view: case-insensitive line match; useful for locating a GUID in large JSON.' },
        wrap: { type: 'number', description: 'For view: line width, default 400; 0 disables wrapping.' },
        pretty: { type: 'boolean', description: 'For view: pretty-render JSON, default true for .json.' },
        target: {
          type: 'string',
          enum: CLASS_IDS,
          description: 'Cleanup scope: one category or all; default all.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Cleanup defaults to dry-run true; pass false only when deletion is confirmed.',
        },
        limit: { type: 'number', description: 'For list: maximum artifacts per category, default 15.' },
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
          t('reports.compacted', { files: result.files, snapshots: result.snapshots, saved: formatBytes(result.savedBytes) }),
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
          const lines = [t('reports.preview', { target }), '', ...planLines(plan)]
          lines.push('', t('reports.confirmDelete'))
          return { schemaVersion: 1, action, text: lines.join('\n') }
        }
        const applied = await applyCleanup(config, plan)
        const summary = await storageSummary(config)
        const lines = [
          t('reports.deleted', { count: applied.deleted.length, size: formatBytes(applied.bytes) }),
          ...(applied.failures.length ? ['', t('reports.failures', { count: applied.failures.length }), ...applied.failures.map((item) => `- ${item.name}: ${item.reason}`)] : []),
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
          lastContractRun = `${last.at} (${last.source} → ${(last.targets ?? []).join(', ')}; blockers ${last.blocker ?? 0} / warnings ${last.warning ?? 0}, waived ${last.waived ?? 0})`
        }
      } catch {
        lastContractRun = ''
      }

      const lines = [t('reports.localData'), '', ...storageLines(summary), '']
      // Totals come from the storage summary, not from the truncated listing:
      // A large total next to a few bullets can look like a bug.
      const classCount = (id) => summary.classes.find((item) => item.id === id)?.count ?? 0
      const reportTotal = classCount('reports')
      lines.push(t('reports.reportsList', { total: reportTotal, more: reportTotal > reports.length ? t('reports.showingLatest', { count: reports.length }) : '' }))
      for (const row of reports) {
        lines.push(`- ${row.name} · ${(row.size / 1024).toFixed(1)} KB · ${row.modifiedAt}`)
      }
      lines.push('')
      const queryTotal = classCount('query')
      const shownQueries = queries.slice(0, 8)
      lines.push(t('reports.queriesList', { total: queryTotal, more: queryTotal > shownQueries.length ? t('reports.showingLatest', { count: shownQueries.length }) : '' }))
      for (const row of shownQueries) {
        lines.push(`- ${row.name} · ${(row.size / 1024).toFixed(1)} KB`)
      }
      lines.push('')
      lines.push(t('reports.waivers', { count: waiverCount }))
      lines.push(t('reports.lastContract', { value: lastContractRun || t('reports.notRun') }))
      lines.push('')
      lines.push(t('reports.viewHelp'))
      return { schemaVersion: 1, action: 'list', text: lines.join('\n') }
    },
  })
  return dispose
}
