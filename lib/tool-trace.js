/**
 * Implementation behind `d365_diagnose` (the `trace-*` actions): read plug-in
 * trace logs — the record of what a plug-in actually saw and did.
 *
 * Metadata says which step is registered; only a trace says why it threw. The
 * three actions answer the three questions that come up in that order:
 *
 *   list     what ran (and failed) in a window
 *   get      what one trace contains — exception, message block, timings
 *   summary  which failures repeat, and whether tracing is even switched on
 *
 * Trace rows are business data, not metadata: they carry record ids, payload
 * XML and sometimes credentials in the secure configuration. They are gated by
 * `data.read` for that reason, and `get` leaves the configuration fields out
 * unless asked for them.
 */
import { loadConfig } from './config.js'
import { formatTable, makeClient, mapEnvironments, pickEnvironments, writeArtifact } from './runtime.js'
import { formatMs, stageSteps } from './perf.js'
import { D365Error } from './errors.js'
import { t } from './i18n.js'

const ACTIONS = ['list', 'get', 'summary', 'stages']
const CONFIG_FIELDS = ['configuration', 'secureconfiguration', 'profile']

// `operationtypename` / `modename` are not selectable on plugintracelog (the
// server answers 0x80060888), so the list keeps to columns that exist: the
// message name, the plug-in type and the exception are what identify a run.
const LIST_SELECT = [
  'plugintracelogid',
  'typename',
  'messagename',
  'primaryentity',
  'depth',
  'performanceexecutionduration',
  'performanceexecutionstarttime',
  'exceptiondetails',
].join(',')

/**
 * First line of an exception, normalised enough to group by.
 *
 * Dataverse writes the type and message on the first line and the stack below
 * it; the stack is what differs between two occurrences of the same bug.
 */
export function exceptionSignature(text) {
  const value = String(text ?? '').replace(/\r/g, '')
  if (!value.trim()) return ''
  const line = value
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith('at ')) ?? ''
  return line.length > 160 ? `${line.slice(0, 160)}…` : line
}

/**
 * Short type name.
 *
 * `typename` is assembly-qualified (`Contoso.Plugins.X, Contoso.Plugins,
 * Version=1.0.0.0, Culture=neutral, PublicKeyToken=...`), so splitting on `.`
 * alone produces assembly noise instead of the class name.
 */
function shortTypeName(value) {
  const text = String(value ?? '').trim()
  if (!text) return '—'
  const withoutAssembly = text.split(',')[0].trim()
  const parts = withoutAssembly.split('.')
  return parts[parts.length - 1] || withoutAssembly
}

/**
 * Key name that carries a credential. The name may be prefixed or suffixed
 * (`client_secret`, `ClientSecret`, `X-Api-Key`, `api_key`, `pwd`), so one
 * pattern feeds all four shapes below and they all mask the same names.
 */
const SECRET_KEY = '[A-Za-z0-9_.-]*(?:secret|password|pwd|token|api[-_]?key|authorization)[A-Za-z0-9_.-]*'

/** One masking marker everywhere, so a reader can tell a mask from real text. */
const MASK = '***'

/**
 * Mask credentials that plug-ins wrote into their own trace.
 *
 * Real traces embed `secureConfig:{"ClientId": "…", "ClientSecret": "…"}`,
 * connection strings (`Password=…;`), headers (`X-Api-Key: …`),
 * `<Password>…</Password>` XML and `Authorization: Bearer …`. The log itself is
 * on the server; this redaction keeps the secret out of the chat transcript and
 * the local artifact, which travel much further.
 *
 * Four regexes, one pass each: JSON, XML, bearer headers, then the generic
 * `key=value` / `key: value` shape. Each is linear, so a 1 MB message block
 * stays cheap.
 * @returns the masked text plus how many values were replaced.
 */
export function redact(input) {
  let count = 0
  const mask = () => {
    count += 1
    return MASK
  }
  const text = String(input ?? '')
    // 1. JSON: `"ClientSecret": "abc"`. An existing marker is left alone so a
    //    second pass over the same text does not inflate the mask count.
    .replace(new RegExp(`("${SECRET_KEY}"\\s*:\\s*")(?!\\*\\*\\*)([^"]*)(")`, 'gi'),
      (_match, head, _value, tail) => `${head}${mask()}${tail}`)
    // 2. XML: `<Password>abc</Password>`.
    .replace(new RegExp(`(<${SECRET_KEY}(?:\\s[^>]*)?>)(?!\\*\\*\\*)([^<]+)(</[A-Za-z0-9_.:-]+>)`, 'gi'),
      (_match, head, _value, tail) => `${head}${mask()}${tail}`)
    // 3. Authentication headers first, so the scheme stays readable and the
    //    credential is masked as one value (`Authorization: Bearer eyJ…`).
    .replace(new RegExp(`((?:proxy-)?authorization\\s*:\\s*(?:(?:bearer|basic|digest|negotiate|ntlm|apikey)\\s+)?)(?!\\*\\*\\*)(?!(?:bearer|basic|digest|negotiate|ntlm|apikey)\\s)([^\\s"',;]+)`, 'gi'),
      (_match, head) => `${head}${mask()}`)
    // 4. Connection strings and headers, including quoted values. Escaped
    //    delimiters remain part of the masked value.
    .replace(new RegExp(`("?${SECRET_KEY}"?\\s*[=:]\\s*)(")(?!\\*\\*\\*)((?:\\\\.|[^"\\\\])*)(")`, 'gi'),
      (_match, head, quote, _value, tail) => `${head}${quote}${mask()}${tail}`)
    .replace(new RegExp(`("?${SECRET_KEY}"?\\s*[=:]\\s*)(')(?!\\*\\*\\*)((?:\\\\.|[^'\\\\])*)(')`, 'gi'),
      (_match, head, quote, _value, tail) => `${head}${quote}${mask()}${tail}`)
    // 5. Unquoted connection-string and header values: `Password=abc;`.
    //    Skipping an existing marker and an auth scheme keeps a second pass
    //    idempotent and stops `Bearer` being masked as the credential.
    .replace(new RegExp(`("?${SECRET_KEY}"?\\s*[=:]\\s*)(?!\\*\\*\\*)(?!(?:bearer|basic|digest|negotiate|ntlm|apikey)\\s)([^\\s;&,<>"'{}]+)`, 'gi'),
      (_match, head) => `${head}${mask()}`)
  return { text, count }
}

/** Shorten a duration in milliseconds for the inline table. */
function formatDuration(ms) {
  const value = Number(ms)
  // `< 0` and not `<= 0`: a step that genuinely took 0 ms is a measurement,
  // not a missing value.
  if (!Number.isFinite(value) || value < 0) return '—'
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`
}

function shortTime(value) {
  const text = String(value ?? '')
  return text.length >= 19 ? text.slice(0, 19).replace('T', ' ') : text || '—'
}

async function readTraceLevel(client, signal) {
  try {
    const org = await client.getOne('organizations', { $select: 'plugintracelogsetting' }, signal)
    const level = Number(org?.plugintracelogsetting)
    return Number.isFinite(level) ? level : undefined
  } catch {
    return undefined
  }
}

function traceLevelNote(level) {
  if (level === undefined) return null
  if (level === 0) {
    return t('trace.offNote')
  }
  if (level === 1) return t('trace.exceptionOnlyNote')
  return null
}

/**
 * Ask the server how many rows a filter matches, when it will say.
 *
 * A paged read stops at the requested size; `hasMore` proves the cap was hit
 * but not how many rows exist. Reporting the cap as the window total is a
 * silent lie, so the summary asks for the count separately and treats "no
 * answer" as unknown instead of guessing.
 * @param path - entity set name.
 * @param filter - the exact `$filter` the sample used.
 * @param select - a cheap single-column `$select` for the count fallback.
 * @returns the exact count, or undefined when neither shape works.
 */
async function countRows(client, path, filter, select, signal) {
  try {
    const page = await client.requestJson(
      client.buildUrl(path, { $filter: filter, $apply: 'aggregate($count as count)' }),
      { signal },
    )
    const exact = Number(page?.value?.[0]?.count)
    if (Number.isFinite(exact)) return exact
  } catch {
    // Fall through to `$count=true`; the aggregate is blocked on some
    // organizations (and on tables where it is not allowed at all).
  }
  try {
    const page = await client.requestJson(
      client.buildUrl(path, { $filter: filter, $select: select, $top: 1, $count: 'true' }),
      { signal },
    )
    const exact = page?.['@odata.count']
    if (Number.isFinite(exact)) return Number(exact)
  } catch {
    // Unknown is reported as a lower bound, never as the total.
  }
  return undefined
}

function buildFilter(args, sinceIso) {
  const parts = [`createdon ge ${sinceIso}`]
  // A successful trace stores an empty string, not null, so `ne null` alone
  // still matches it — that is how a "failures only" list came back with clean
  // runs.
  if (args.exceptionOnly !== false) parts.push('exceptiondetails ne null', "exceptiondetails ne ''")
  if (args.entity) parts.push(`primaryentity eq '${String(args.entity).replace(/'/g, "''")}'`)
  if (args.message) parts.push(`messagename eq '${String(args.message).replace(/'/g, "''")}'`)
  if (args.typename) {
    const value = String(args.typename).replace(/'/g, "''")
    parts.push(`contains(typename,'${value}')`)
  }
  return parts.join(' and ')
}

export async function run(state, args = {}, exec) {
  const config = await loadConfig(state.rawConfig)
  const action = args.action
  if (!ACTIONS.includes(action)) {
    throw new D365Error(`Unknown action: ${action}`, { code: 'unknown-action', i18nParams: { action }, i18nKey: 'trace.unknownAction', hintKey: 'trace.unknownActionHint', hintParams: { values: ACTIONS.join(' / ') } })
  }
  if (action === 'get' && !String(args.traceId ?? '').trim()) {
    throw new D365Error('action=get requires traceId', { code: 'missing-trace-id', i18nKey: 'trace.traceIdRequired', hintKey: 'trace.traceIdRequiredHint' })
  }

  const envs = pickEnvironments(config, args)
  const hours = Number.isFinite(args.hours) ? Math.max(1, Math.min(24 * 30, args.hours)) : 24
  const sinceIso = new Date(Date.now() - hours * 3600_000).toISOString()
  const reports = []
  const artifact = { action, hours, filter: undefined, environments: {} }

  await mapEnvironments(envs, async (env, index) => {
    try {
    const client = makeClient(env, config)
    // `get` does not need the org setting: the row itself is the evidence.
    // Reading it anyway costs an extra `organizations` request per call.
    const level = action === 'get' ? undefined : await readTraceLevel(client, exec?.signal)
    const note = traceLevelNote(level)

    if (action === 'get' || action === 'stages') {
      const id = String(args.traceId).trim()
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new D365Error(`traceId is not a GUID: ${id}`, { code: 'bad-id', i18nParams: { id }, i18nKey: 'trace.badId', hintKey: 'trace.badIdHint' })
      }
      const params = {}
      const rows = await client.requestJson(
        client.buildUrl(`plugintracelogs(${id})`, params),
        { signal: exec?.signal },
      ).catch((error) => {
        if (error?.status === 404) {
          throw new D365Error(`${env.key} has no trace record with id ${id}`, { code: 'trace-not-found', i18nParams: { environment: env.key, id }, i18nKey: 'trace.notFound', hintKey: 'trace.notFoundHint' })
        }
        throw error
      })
      const row = Array.isArray(rows?.value) ? rows.value[0] : rows
      if (!row) throw new D365Error(`${env.key} returned no trace ${id}`, { code: 'trace-not-found', i18nParams: { environment: env.key, id }, i18nKey: 'trace.emptyResult' })
      if (!args.includeConfig) {
        for (const field of CONFIG_FIELDS) delete row[field]
      }
      // Plug-ins write their own credentials into the message block; mask
      // them before this text becomes a transcript and a local artifact.
      let masked = 0
      for (const field of ['messageblock', 'exceptiondetails', 'configuration', 'secureconfiguration', 'profile']) {
        if (typeof row[field] !== 'string') continue
        const result = redact(row[field])
        row[field] = result.text
        masked += result.count
      }
      artifact.environments[env.key] = { traceLevel: level ?? null, trace: row, maskedValues: masked }
      if (action === 'stages') {
        const { marks, steps } = stageSteps(row.messageblock)
        const clock = (at) => [
          String(Math.floor(at / 3600_000)).padStart(2, '0'),
          String(Math.floor(at / 60_000) % 60).padStart(2, '0'),
          String(Math.floor(at / 1000) % 60).padStart(2, '0'),
        ].join(':') + `.${String(at % 1000).padStart(3, '0')}`
        const lines = [
          t('trace.stagesHeading', { environment: env.key, id }),
          `- ${t('trace.pluginType')}: ${row.typename ?? '—'}`,
          `- ${t('trace.messageTable')}: ${row.messagename ?? '—'} / ${row.primaryentity ?? '—'}`,
          `- ${t('trace.duration')}: ${formatDuration(row.performanceexecutionduration)}`,
        ]
        if (marks.length < 2) {
          lines.push('', t('trace.tooFewMarks'))
        } else {
          const span = marks[marks.length - 1].at - marks[0].at
          lines.push(`- ${t('trace.timestampSpan', { span: formatMs(span), count: marks.length })}`)
          lines.push('', t('trace.stageTableHead'), '| --- | --- | --- |')
          for (const step of [...steps].sort((a, b) => b.delta - a.delta).slice(0, 15)) {
            lines.push(`| ${clock(step.from.at)} | ${formatMs(step.delta)} | ${step.to.label.slice(0, 80)} |`)
          }
          const widest = [...steps].sort((a, b) => b.delta - a.delta)[0]
          if (widest) lines.push('', t('trace.largestGap', { gap: formatMs(widest.delta), label: widest.to.label.slice(0, 100) }))
          lines.push('', t('trace.gapNote'))
        }
        artifact.environments[env.key].stages = steps.map((step) => ({
          from: clock(step.from.at),
          deltaMs: step.delta,
          label: step.to.label,
        }))
        reports[index] = lines.join('\n')
        return
      }
      const blocks = [
        t('trace.heading', { environment: env.key, id }),
        `- Plug-in type: ${row.typename ?? '—'}`,
        `- Message / table: ${row.messagename ?? '—'} / ${row.primaryentity ?? '—'}`,
        `- ${t('trace.depth')}: ${row.depth ?? '—'}`,
        `- ${t('trace.durationStarted', { duration: formatDuration(row.performanceexecutionduration), started: shortTime(row.performanceexecutionstarttime) })}`,
      ]
      if (row.exceptiondetails) {
        blocks.push('', `${t('trace.exception')}:`, String(row.exceptiondetails).slice(0, 3000))
      } else {
        blocks.push('', t('trace.noException'))
      }
      if (row.messageblock) {
        // Dataverse keeps only the last 10240 characters of the message
        // block, and a fixed head slice hides exactly the failure at the end.
        const block = String(row.messageblock)
        const shown = block.length <= 4000
          ? block
          : `${block.slice(0, 1200)}\n… (${block.length - 3600} middle characters omitted) …\n${block.slice(-2400)}`
        blocks.push('', t('trace.messageblock'), shown)
      }
      if (masked > 0) {
        blocks.push('', t('trace.masked', { count: masked }))
      }
      if (note) blocks.push('', note)
      if (!args.includeConfig) {
        blocks.push('', t('trace.configOmitted'))
      }
      reports[index] = blocks.join('\n')
      return
    }

    const filter = buildFilter(args, sinceIso)
    artifact.filter = filter

    if (action === 'list') {
      const top = Number.isFinite(args.top) ? Math.max(1, Math.min(200, args.top)) : 20
      const page = await client.getPaged('plugintracelogs', {
        $select: LIST_SELECT,
        $filter: filter,
        $orderby: 'createdon desc',
      }, top, exec?.signal)
      const rows = page.records ?? []
      // The same masking the get branch does: these rows go into the
      // artifact and the transcript, and plug-ins do write credentials into
      // exception text.
      let masked = 0
      for (const row of rows) {
        for (const field of ['messageblock', 'exceptiondetails']) {
          if (typeof row[field] !== 'string') continue
          const result = redact(row[field])
          row[field] = result.text
          masked += result.count
        }
      }
      artifact.environments[env.key] = { traceLevel: level ?? null, rows, hasMore: page.hasMore, maskedValues: masked }
      const table = rows.length
        ? formatTable(rows.map((row) => ({
          ...row,
          typename: row.typename ?? '—',
          'plugin/message': `${shortTypeName(row.typename)} / ${row.messagename ?? '—'}`,
          at: shortTime(row.performanceexecutionstarttime),
          duration: formatDuration(row.performanceexecutionduration),
          exception: exceptionSignature(row.exceptiondetails) || '—',
        })), ['at', 'plugin/message', 'primaryentity', 'duration', 'exception'], { width: 44 })
        : t('trace.noMatching')
      const head = rows.length
        ? t(args.exceptionOnly === false ? 'trace.listAll' : 'trace.listFailed', { environment: env.key, hours, rows: rows.length, more: page.hasMore ? t('trace.limitReached') : '' })
        : t(args.exceptionOnly === false ? 'trace.noAll' : 'trace.noFailed', { environment: env.key, hours })
      reports[index] = [head, table, note].filter(Boolean).join('\n')
      return
    }

    // summary: pull a bounded sample of failures and aggregate by signature
    // locally — a memo column (exceptiondetails) cannot be grouped
    // server-side.
    const limit = Number.isFinite(args.top) ? Math.max(1, Math.min(500, args.top)) : 300
    const summaryFilter = buildFilter({ ...args, exceptionOnly: true }, sinceIso)
    const page = await client.getPaged('plugintracelogs', {
      $select: 'plugintracelogid,typename,messagename,primaryentity,exceptiondetails,performanceexecutionstarttime',
      $filter: summaryFilter,
      $orderby: 'createdon desc',
    }, limit, exec?.signal)
    const rows = page.records ?? []
    // `sampled` is what was read; `total` is what the window holds. They
    // differ exactly when the read hit its cap, and a capped sample must
    // never be reported as the total.
    const sampled = rows.length
    const total = page.hasMore
      ? await countRows(client, 'plugintracelogs', summaryFilter, 'plugintracelogid', exec?.signal)
      : sampled
    let masked = 0
    const groups = new Map()
    for (const raw of rows) {
      if (typeof raw.exceptiondetails === 'string') {
        const result = redact(raw.exceptiondetails)
        raw.exceptiondetails = result.text
        masked += result.count
      }
      const row = raw
      const signature = exceptionSignature(row.exceptiondetails)
      const key = `${row.typename ?? ''}|${row.messagename ?? ''}|${row.primaryentity ?? ''}|${signature}`
      const entry = groups.get(key) ?? {
        typename: row.typename ?? '—',
        message: row.messagename ?? '—',
        entity: row.primaryentity ?? '—',
        signature: signature || '—',
        count: 0,
        first: shortTime(row.performanceexecutionstarttime),
        last: shortTime(row.performanceexecutionstarttime),
        sampleId: row.plugintracelogid,
      }
      entry.count += 1
      const at = shortTime(row.performanceexecutionstarttime)
      if (at < entry.first) entry.first = at
      if (at > entry.last) entry.last = at
      groups.set(key, entry)
    }
    const summary = [...groups.values()].sort((a, b) => b.count - a.count)        // Distinguish "no traces at all" from "traces, but none failed".
    let anyTraces = rows.length > 0
    if (!anyTraces) {
      const probe = await client.getPaged('plugintracelogs', {
        $select: 'plugintracelogid',
        $filter: `createdon ge ${sinceIso}`,
      }, 1, exec?.signal).catch(() => ({ records: [] }))
      anyTraces = (probe.records ?? []).length > 0
    }
    const exactTotal = Number.isFinite(total) ? total : null
    artifact.environments[env.key] = {
      traceLevel: level ?? null,
      sampled,
      total: exactTotal,
      capped: page.hasMore === true,
      signatures: summary,
      maskedValues: masked,
    }
    const head = rows.length === 0
      ? anyTraces
        ? t('trace.tracesNoFailures', { environment: env.key, hours })
        : t('trace.noRecords', { environment: env.key, hours })
      : page.hasMore
        ? exactTotal === null
          ? t('trace.summaryLowerBound', { environment: env.key, hours, sampled, signatures: summary.length })
          : t('trace.summaryExactCapped', { environment: env.key, hours, total: exactTotal, sampled, signatures: summary.length })
        : t('trace.summaryExact', { environment: env.key, hours, sampled, signatures: summary.length })
    const table = summary.length
      ? formatTable(summary.map((item) => ({
        ...item,
        'plugin/message': `${shortTypeName(item.typename)} / ${item.message}`,
        signature: item.signature,
      })), ['count', 'plugin/message', 'entity', 'signature', 'last'], { width: 40 })
      : ''
    const tips = []
    if (note) tips.push(note)
    if (page.hasMore) {
      // The per-signature counts coming out of `summary` are counts inside
      // the sample, so say it once here instead of letting the table read
      // like a full-window histogram.
      tips.push(exactTotal === null
        ? t('trace.sampleUnknown', { sampled })
        : t('trace.sampleExact', { sampled, total: exactTotal }))
    }
    if (anyTraces && !rows.length) {
      tips.push(t('trace.noExceptionTip'))
    }
    if (summary.length === 1) {
      tips.push(t('trace.oneSignatureTip', { id: summary[0].sampleId }))
    }
    reports[index] = [head, table, ...tips].filter(Boolean).join('\n')
    } catch (error) {
      // One environment failing must not erase the others.
      reports[index] = [t('trace.queryFailed', { environment: env.key }), `- ${error?.message ?? String(error)}`, error?.hint ? `- ${t('trace.hint')}: ${error.hint}` : '']
        .filter(Boolean).join('\n')
    }
  })

  const file = await writeArtifact(config, `trace-${action}`, artifact)
  return { text: `${reports.filter(Boolean).join('\n\n')}\n\n${t('trace.fullResults', { file })}`, artifactPath: file }
}
