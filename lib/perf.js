/**
 * Slow-execution analysis over plug-in trace logs.
 *
 * The trace table already records `performanceexecutionduration` per row, but a
 * list of individual calls answers "did this one fail", not "why is this slow":
 * a hundred 2.4-second calls and one 240-second call look the same in a list.
 * Everything here is local aggregation over a bounded sample, so it costs one
 * paged read and no new permission.
 *
 * Two honesty rules, because a wrong number is worse than no number:
 *   1. Every output states the window, the sample size and whether the sample
 *      was capped — a p95 over the first 5000 of 40000 rows is not a p95.
 *   2. Trace level is reported with the sample: when tracing is off, an empty
 *      window means "nobody was recording", not "nothing was slow".
 */
import { D365Error } from './errors.js'
import { getPagedWithSelectFallback } from './client.js'
import { traceLabel } from './health.js'

/** Rows pulled per environment before the sample is declared capped. */
export const PERF_SAMPLE_LIMIT = 5000

const SELECT = [
  'plugintracelogid',
  'typename',
  'messagename',
  'primaryentity',
  'performanceexecutionstarttime',
  'performanceexecutionduration',
].join(',')

/** Nearest-rank percentile over a numeric array (already filtered). */
export function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[rank]
}

/** `1234` → `1.2s`; `45` → `45ms`. */
export function formatMs(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}min`
}

/** The org's plug-in trace setting, or undefined when it cannot be read. */
export async function readTraceLevel(client, signal) {
  try {
    const row = await client.getOne('organizations', { $select: 'plugintracelogsetting' }, signal)
    const level = Number(row?.plugintracelogsetting)
    return Number.isFinite(level) ? level : undefined
  } catch {
    return undefined
  }
}

/**
 * The conditions that decide whether a perf number means anything.
 * @returns lines to print above the tables.
 */
export function sampleHeader({ env, hours, rows, capped, level, filter }) {
  const sampled = Array.isArray(rows) ? rows.length : rows
  const parts = [
    `最近 ${hours} 小时的插件执行耗时`,
    `样本 ${sampled} 条${capped ? `（已达 ${PERF_SAMPLE_LIMIT} 条上限，统计只覆盖前这么多）` : ''}`,
    `跟踪级别：${traceLabel(level ?? -1)}`,
  ]
  const lines = [`${env}：${parts.join('；')}`]
  if (filter) lines.push(`- 过滤：${filter}`)
  if (level === 0) {
    lines.push('- 注意：组织的插件跟踪是关闭的，成功执行的记录不会写进来；这里的分布只代表「有记录的那部分」。')
  } else if (level === 1) {
    lines.push('- 注意：跟踪级别是「仅异常」，成功执行不写记录；所以这里的分布是失败调用的分布。')
  }
  return lines
}

/** Group duration rows by plug-in type + message. */
export function groupDurations(rows) {
  const groups = new Map()
  for (const row of rows) {
    const duration = Number(row.performanceexecutionduration)
    if (!Number.isFinite(duration)) continue
    const key = `${row.typename ?? ''}|${row.messagename ?? ''}`
    const entry = groups.get(key) ?? {
      typename: row.typename ?? '—',
      message: row.messagename ?? '—',
      entities: new Set(),
      durations: [],
    }
    entry.durations.push(duration)
    if (row.primaryentity) entry.entities.add(row.primaryentity)
    groups.set(key, entry)
  }
  return [...groups.values()].map((entry) => {
    const total = entry.durations.reduce((sum, value) => sum + value, 0)
    return {
      typename: entry.typename,
      message: entry.message,
      entities: [...entry.entities],
      count: entry.durations.length,
      total,
      p50: percentile(entry.durations, 50),
      p95: percentile(entry.durations, 95),
      max: Math.max(...entry.durations),
    }
  })
}

/** Bucket rows by hour (or day) for a trend line. */
export function bucketDurations(rows, bucket = 'hour') {
  const size = bucket === 'day' ? 86_400_000 : 3_600_000
  const buckets = new Map()
  for (const row of rows) {
    const duration = Number(row.performanceexecutionduration)
    const at = Date.parse(row.performanceexecutionstarttime ?? '')
    if (!Number.isFinite(duration) || !Number.isFinite(at)) continue
    const key = Math.floor(at / size) * size
    const entry = buckets.get(key) ?? { at: key, durations: [], total: 0 }
    entry.durations.push(duration)
    entry.total += duration
    buckets.set(key, entry)
  }
  return [...buckets.values()]
    .sort((a, b) => a.at - b.at)
    .map((entry) => ({
      at: new Date(entry.at).toISOString(),
      count: entry.durations.length,
      total: entry.total,
      p50: percentile(entry.durations, 50),
      p95: percentile(entry.durations, 95),
      max: Math.max(...entry.durations),
    }))
}

/**
 * Pull the rows the analysis runs on.
 * @returns `{ rows, capped, level }`
 */
export async function readSlowRows(client, args, signal) {
  const hours = Number.isFinite(args.hours) ? Math.max(1, Math.min(24 * 30, args.hours)) : 72
  const sinceIso = new Date(Date.now() - hours * 3600_000).toISOString()
  const parts = [`createdon ge ${sinceIso}`]
  if (args.entity) parts.push(`primaryentity eq '${String(args.entity).replace(/'/g, "''")}'`)
  if (args.message) parts.push(`messagename eq '${String(args.message).replace(/'/g, "''")}'`)
  if (args.typename) parts.push(`contains(typename,'${String(args.typename).replace(/'/g, "''")}')`)
  if (Number.isFinite(args.minDuration)) parts.push(`performanceexecutionduration ge ${Math.trunc(args.minDuration)}`)
  if (String(args.filter ?? '').trim()) parts.push(`(${String(args.filter).trim()})`)
  const filter = parts.join(' and ')

  const paged = await getPagedWithSelectFallback(client, 'plugintracelogs', {
    $select: SELECT,
    $filter: filter,
    $orderby: 'createdon desc',
  }, PERF_SAMPLE_LIMIT, signal)

  const level = await readTraceLevel(client, signal)
  return { rows: paged.page.records ?? [], capped: paged.page.hasMore === true, level, filter, hours, sinceIso }
}

/** Render one environment's hotspots. */
export function renderHotspots(env, sample, args) {
  const groups = groupDurations(sample.rows)
  const top = Number.isFinite(args.top) ? Math.max(1, Math.min(100, args.top)) : 20
  const sorted = [...groups].sort((a, b) => b.total - a.total).slice(0, top)
  const lines = sampleHeader({ ...sample, env })
  if (!sample.rows.length) {
    lines.push('- 窗口里没有执行记录。跟踪级别低时成功执行不写日志；先看 d365_health 的「插件跟踪」列。')
    return { text: lines.join('\n'), groups: sorted }
  }
  lines.push('', '| 插件类型 / 消息 | 次数 | 合计 | p50 | p95 | 最慢 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const group of sorted) {
    lines.push(`| ${shortType(group.typename)} / ${group.message} | ${group.count} | ${formatMs(group.total)} | ${formatMs(group.p50)} | ${formatMs(group.p95)} | ${formatMs(group.max)} |`)
  }
  lines.push('', '按「合计」排序：它回答「时间都花在哪」，而不是「哪一条最慢」。')
  return { text: lines.join('\n'), groups: sorted }
}

/** Render the slowest individual calls. */
export function renderSlowest(env, sample, args) {
  const top = Number.isFinite(args.top) ? Math.max(1, Math.min(100, args.top)) : 20
  const rows = sample.rows
    .filter((row) => Number.isFinite(Number(row.performanceexecutionduration)))
    .sort((a, b) => Number(b.performanceexecutionduration) - Number(a.performanceexecutionduration))
    .slice(0, top)
  const lines = sampleHeader({ ...sample, env })
  if (!rows.length) {
    lines.push('- 窗口里没有执行记录。')
    return { text: lines.join('\n'), rows }
  }
  lines.push('', '| 开始时间 | 插件类型 / 消息 | 表 | 耗时 | trace |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const row of rows) {
    lines.push(`| ${shortTime(row.performanceexecutionstarttime)} | ${shortType(row.typename)} / ${row.messagename ?? '—'} | ${row.primaryentity ?? '—'} | ${formatMs(row.performanceexecutionduration)} | ${row.plugintracelogid} |`)
  }
  lines.push('', '要拆一条的构成，用 d365_trace action=stages traceId="…"（读它 messageblock 里的时间戳）。')
  return { text: lines.join('\n'), rows }
}

/** Render the per-hour trend. */
export function renderTrend(env, sample, args) {
  const bucket = args.bucket === 'day' ? 'day' : 'hour'
  const rows = bucketDurations(sample.rows, bucket)
  const lines = sampleHeader({ ...sample, env })
  if (!rows.length) {
    lines.push('- 窗口里没有执行记录。')
    return { text: lines.join('\n'), rows }
  }
  lines.push('', `| ${bucket === 'day' ? '日期' : '小时'} | 次数 | 合计 | p50 | p95 | 最慢 |`)
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const row of rows) {
    lines.push(`| ${row.at.slice(0, bucket === 'day' ? 10 : 13).replace('T', ' ')} | ${row.count} | ${formatMs(row.total)} | ${formatMs(row.p50)} | ${formatMs(row.p95)} | ${formatMs(row.max)} |`)
  }
  const peak = [...rows].sort((a, b) => b.total - a.total)[0]
  const busy = [...rows].sort((a, b) => b.count - a.count)[0]
  lines.push('', `峰值：${peak.at.slice(0, 16).replace('T', ' ')} 合计 ${formatMs(peak.total)}；调用最密：${busy.at.slice(0, 16).replace('T', ' ')}（${busy.count} 次）。`)
  return { text: lines.join('\n'), rows }
}

/**
 * Timestamps inside a plug-in message block.
 *
 * Dataverse prefixes each entry with a timestamp; the gaps between them are the
 * only per-stage timing a trace gives us. Misses are fine — an entry without a
 * timestamp simply does not become a mark.
 */
export function stageMarks(text) {
  // Two shapes occur in practice:
  //   Time Stamp:- 11/16/2026 06:10:25   (what most org plug-ins write)
  //   06:10:25.123 some message          (what Trace(...) style helpers write)
  const stampPattern = /Time Stamp:?\s*-?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/i
  const clockPattern = /(?:^|[^\d])(\d{1,2}):(\d{2}):(\d{2})\.(\d{1,3})(?![\d])/
  const messagePattern = /Message:\s*-?\s*(.*)$/i
  const lines = String(text ?? '').split(/\r?\n/)
  const marks = []
  let dayOffset = 0
  let lastDate = ''

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    let at = null
    const stamped = stampPattern.exec(line)
    if (stamped) {
      const [, month, day, year, hh, mm, ss, ms] = stamped
      const date = `${year}-${month}-${day}`
      if (lastDate && date !== lastDate) dayOffset += 86_400_000
      lastDate = date
      at = dayOffset + clockToMs(hh, mm, ss, ms)
    } else if (!/^\s*Time Stamp:/i.test(line)) {
      const clock = clockPattern.exec(line)
      if (clock) at = clockToMs(clock[1], clock[2], clock[3], clock[4])
    }
    if (at === null) continue

    let label = messagePattern.exec(line)?.[1]?.trim() ?? ''
    if (!label) {
      // `Time Stamp:-` and `Message:-` sit on separate lines.
      for (let next = index + 1; next < Math.min(index + 4, lines.length); next += 1) {
        const found = messagePattern.exec(lines[next])
        if (found) {
          label = found[1].trim()
          break
        }
      }
    }
    marks.push({ at, label: (label || `第 ${index + 1} 行`).slice(0, 160) })
  }
  return marks
}

function clockToMs(hh, mm, ss, ms) {
  return Number(hh) * 3_600_000 + Number(mm) * 60_000 + Number(ss) * 1000 + Number(ms ?? 0)
}

/**
 * @returns `{ marks, steps }` where each step is the gap that precedes a mark.
 */
export function stageSteps(text) {
  const marks = stageMarks(text)
  const steps = []
  for (let index = 1; index < marks.length; index += 1) {
    const delta = marks[index].at - marks[index - 1].at
    // A negative gap means the block crossed midnight or the timestamps are not
    // monotonic; keep it visible instead of silently zeroing it.
    steps.push({ from: marks[index - 1], to: marks[index], delta })
  }
  return { marks, steps }
}

/** Shorten an assembly-qualified type name for a table cell. */
export function shortType(name) {
  const first = String(name ?? '—').split(',')[0]
  return first.split('.').pop() || first
}

export function shortTime(value) {
  const text = String(value ?? '')
  if (!text) return '—'
  return text.slice(11, 19) || text
}

/** A sample of 5000 with no rows is a configuration answer, not a slow answer. */
export function emptyExplanation(level) {
  if (level === 0) return '插件跟踪是关闭的：成功执行不写日志，所以这里没有样本。'
  if (level === 1) return '跟踪级别是「仅异常」：成功执行不写日志，这里只有失败调用。'
  return '窗口里确实没有执行记录。'
}

export function assertRows(rows, level) {
  if (rows.length) return
  throw new D365Error('没有可供分析的执行记录', {
    code: 'no-perf-rows',
    hint: `${emptyExplanation(level)}放宽 hours、去掉 entity/typename 过滤，或先在环境里打开插件跟踪。`,
  })
}
