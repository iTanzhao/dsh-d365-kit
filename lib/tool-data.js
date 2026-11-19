/**
 * `d365_data` — the data half of "who uses this".
 *
 * Metadata references say a field is on a form; they do not say whether 12 or
 * 120000 records carry a value in it. Before deleting a field or an option
 * value, the count is the part that decides. Every read here goes through the
 * normal client, so it is refused unless the environment grants `data.read`.
 *
 * Aggregation uses OData `$apply`, which Dataverse supports on ordinary entity
 * sets; when a server rejects it the tool falls back to paging and counting.
 */
import { loadConfig } from './config.js'
import { INLINE_ROWS, formatTable, makeClient, mapEnvironments, pickEnvironments, writeArtifact } from './runtime.js'
import { getPagedWithSelectFallback } from './client.js'
import { D365Error } from './errors.js'
import { odataString } from './resources.js'
import { t } from './i18n.js'

const ACTIONS = ['count', 'group', 'sample', 'query']

export const definition = {
  name: 'd365_data',
  description:
    'Read business records: count, group by a field, sample, or query by columns, ordering, expansion, or key. '
    + 'Use it to estimate impact before metadata changes or retrieve a record for later writes. '
    + 'Requires reading business data (data.read); metadata reads are separately controlled and enabled by default. '
    + 'Read-only; use d365_data_write for one record, d365_data_sync for batches, and d365_metadata for table structure.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'entity'],
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'Count rows; group counts by field; sample retrieves a few rows; query accepts select/orderby/expand/id.',
      },
      entity: {
        type: 'string',
        description: 'Entity logical name, such as account, or collection name, such as accounts.',
      },
      filter: {
        type: 'string',
        description: 'OData $filter without the $filter= prefix, for example "statecode eq 0".',
      },
      field: {
        type: 'string',
        description: 'Required for group: logical name of the grouping column, such as contoso_taxcategory.',
      },
      select: {
        type: 'string',
        description: 'Columns for sample/query, comma-separated. Sample defaults to the first five; query uses returned-row columns.',
      },
      orderby: {
        type: 'string',
        description: 'Sort expression for query, for example "modifiedon desc".',
      },
      expand: {
        type: 'string',
        description: '$expand for query, for example "primarycontactid($select=fullname)".',
      },
      id: {
        type: 'string',
        description: 'For query: fetch one row by primary key GUID or alternate-key literal, such as contoso_code=\'001\'.',
      },
      top: {
        type: 'integer',
        description: 'sample row count (default 5, maximum 100); group count (default 20); query row count (default 25, maximum 500).',
      },
      environment: {
        type: 'string',
        description: 'Environment key; the configured default is used when omitted.',
      },
      environments: {
        type: 'array',
        items: { type: 'string' },
        description: 'Query multiple environments.',
      },
      allEnvironments: {
        type: 'boolean',
        description: 'Run the same query in every configured environment.',
      },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
    render(_args, value) {
      return [{ type: 'text', text: value?.text ?? '' }]
    },
  },
}

const GUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
// One alternate-key literal: `field='value'`, with no quote or path syntax inside.
const ALTERNATE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*='[^'\/?&#]*'$/

/**
 * Validate the path segment that addresses one record.
 *
 * The URL is built by appending this segment to the entity set, so a value
 * containing `/`, `?`, `&`, `..` or an extra quote can normalize into a
 * different collection — metadata tables included. Only a GUID or a single
 * alternate-key literal is a record address.
 * @returns the key exactly as it goes into `set(key)`.
 */
export function recordKey(value) {
  const key = String(value ?? '').trim()
  if (GUID_PATTERN.test(key)) return key
  if (ALTERNATE_KEY_PATTERN.test(key)) return key
  throw new D365Error(t('data.error.badId', { id: key }), {
    code: 'bad-id',
    hint: t('data.hint.badId'),
  })
}

/**
 * Resolve the entity set name.
 *
 * EntitySetName is customisable, so guessing `${entity}s` is only a fallback:
 * the metadata read is authoritative and cheap.
 * @returns the collection path segment.
 */
export async function resolveEntitySet(client, entity, signal) {
  const candidate = String(entity).trim()
  if (!candidate) throw new D365Error(t('data.error.missingEntity'), { code: 'missing-entity' })
  // A logical name cannot contain a quote; anything that does is either a typo
  // or an attempt to widen the filter, and either way must not be interpolated.
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(candidate)) {
    throw new D365Error(t('data.error.badEntity', { entity: candidate }), {
      code: 'bad-entity',
      hint: t('data.hint.badEntity'),
    })
  }
  // Keyed metadata paths reject `$top`, so ask the collection form instead —
  // the same shape `d365_metadata` already uses successfully.
  try {
    const result = await getPagedWithSelectFallback(client, 'EntityDefinitions', {
      // The definition collection rejects $top; ask without it rather than
      // spending a request on the rejection every time.
      __noTop: true,
      $select: 'LogicalName,EntitySetName,PrimaryIdAttribute',
      $filter: `LogicalName eq '${odataString(candidate)}'`,
    }, 2, signal)
    const row = result?.page?.records?.[0]
    if (row?.EntitySetName) {
      return { set: row.EntitySetName, logical: row.LogicalName ?? candidate, idField: row.PrimaryIdAttribute }
    }
  } catch (error) {
    // Only a rejected query means "no such entity"; auth failures, timeouts
    // and the like must surface as themselves, not as a misleading 404.
    if (error?.status !== 400 && error?.status !== 404 && error?.code !== 'unknown-entity') throw error
  }
  if (!/s$/.test(candidate)) {
    throw new D365Error(t('data.error.entityNotFound', { entity: candidate }), {
      code: 'unknown-entity',
      hint: t('data.hint.entityNames'),
    })
  }
  return { set: candidate, logical: candidate }
}

/** Count rows, using `$apply` first and `$count=true` as a fallback. */
async function countRows(client, set, filter, signal) {
  const params = filter ? { $filter: filter } : {}
  try {
    const page = await client.getPaged(set, { ...params, $apply: 'aggregate($count as count)' }, 5, signal)
    const value = page.records?.[0]?.count
    if (typeof value === 'number') return { count: value, capped: false }
  } catch (error) {
    // A permission refusal is not "this set rejects $apply" — surface it.
    if (error?.code === 'data-read-forbidden') throw error
  }
  try {
    const page = await client.requestJson(
      client.buildUrl(set, { ...params, $count: 'true', $top: '1' }),
      { signal },
    )
    if (typeof page?.['@odata.count'] === 'number') {
      // `@odata.count` stops at 5000: a table with five million rows reports
      // 5000, which reads as a real total. Say so instead of guessing.
      return { count: page['@odata.count'], capped: page['@odata.count'] >= 5000 }
    }
  } catch (error) {
    if (error?.code === 'data-read-forbidden') throw error
  }
  throw new D365Error(t('data.error.countUnavailable', { set }), {
    code: 'count-unavailable',
    hint: t('data.hint.countUnavailable'),
  })
}

/**
 * Keep the columns the caller asked for even when the response disagrees.
 *
 * Selecting a lookup by its attribute name returns nothing — Dataverse exposes
 * the value as `_<name>_value` — and an unselectable or misspelled column
 * silently comes back absent. Both used to render as an empty cell with no
 * explanation, which reads as "this record has no value".
 * @returns `{ columns, notes }` — `notes` is empty when everything resolved.
 */
function reconcileColumns(columns, rows) {
  const notes = []
  if (!columns?.length || !rows.length) return { columns: columns ?? [], notes }
  const present = new Set(Object.keys(rows[0]))
  const resolved = []
  for (const name of columns) {
    if (present.has(name)) {
      if (!resolved.includes(name)) resolved.push(name)
      continue
    }
    const lookup = `_${name}_value`
    if (present.has(lookup)) {
      if (!resolved.includes(lookup)) resolved.push(lookup)
      notes.push(t('data.note.lookup', { name, lookup }))
      continue
    }
    if (!resolved.includes(name)) resolved.push(name)
    notes.push(t('data.note.missing', { name }))
  }
  return { columns: resolved, notes }
}

/** One-line cost tag: a retry-happy call should look expensive in the summary. */
function costText(requests, started) {
  const seconds = Math.max(0, Date.now() - started) / 1000
  return t('data.cost', { requests, seconds: seconds.toFixed(1) })
}

function notesText(notes) {
  return notes?.length ? `\n${t('data.notesHeading')}\n${notes.map((note) => `- ${note}`).join('\n')}` : ''
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args, exec) {
      const config = await loadConfig(state.rawConfig)
      const action = args.action
      if (!ACTIONS.includes(action)) {
        throw new D365Error(t('data.error.unknownAction', { action }), { code: 'unknown-action', hint: t('data.hint.actions', { actions: ACTIONS.join(' / ') }) })
      }
      if (action === 'group' && !args.field) {
        throw new D365Error(t('data.error.groupField'), { code: 'missing-field' })
      }

      const envs = pickEnvironments(config, args)
      const artifact = { action, entity: args.entity, filter: args.filter, environments: {} }

      // Render inside the worker and keep the results in `envs` order: pushing
      // into a shared array would order the sections by completion instead.
      const blocks = await mapEnvironments(envs, async (env) => {
        try {
        const started = Date.now()
        const client = makeClient(env, config)
        const { set, logical } = await resolveEntitySet(client, args.entity, exec?.signal)
        const filter = args.filter

        if (action === 'count') {
          const counted = await countRows(client, set, filter, exec?.signal)
          artifact.environments[env.key] = { entitySet: set, count: counted.count, capped: counted.capped || undefined }
          const cappedNote = counted.capped ? t('data.countCapped') : ''
          return t('data.countSummary', { env: env.key, entity: logical, count: counted.count, capped: cappedNote, filter: filter ? t('data.filtered', { filter }) : '', cost: costText(client.counters.requests, started) })
          return
        }

        if (action === 'group') {
          const apply = `groupby((${args.field}),aggregate($count as count))`
          const page = await client.getPaged(set, {
            ...(filter ? { $filter: filter } : {}),
            $apply: apply,
          }, Number.isFinite(args.top) ? Math.max(1, Math.min(500, args.top)) : 20, exec?.signal)
          const rows = page.records ?? []
          const display = rows.map((row) => ({ ...row, [args.field]: row[args.field] ?? t('data.empty') }))
          const total = rows.reduce((sum, row) => sum + (row.count ?? 0), 0)
          artifact.environments[env.key] = { entitySet: set, field: args.field, groups: rows }
          const table = formatTable(display, [args.field, 'count'], { width: 46 })
          return `${t('data.groupSummary', { env: env.key, field: args.field, groups: rows.length, total })}\n${table}`
          return
        }

        if (action === 'query') {
          const top = Number.isFinite(args.top) ? Math.max(1, Math.min(500, args.top)) : 25
          const columns = args.select
            ? args.select.split(',').map((item) => item.trim()).filter(Boolean)
            : null
          if (args.id !== undefined && args.id !== null && String(args.id).trim()) {
            const key = recordKey(args.id)
            const params = {}
            if (args.select) params.$select = args.select
            if (args.expand) params.$expand = args.expand
            let row
            try {
              row = await client.requestJson(client.buildUrl(`${set}(${key})`, params), { signal: exec?.signal })
            } catch (error) {
              if (error?.status === 404) {
                throw new D365Error(t('data.error.recordNotFoundIn', { env: env.key, entity: logical, key }), {
                  code: 'record-not-found',
                  hint: t('data.hint.recordEnvironment'),
                })
              }
              throw error
            }
            if (!row || typeof row !== 'object') {
              throw new D365Error(t('data.error.recordNotReturned', { env: env.key, entity: logical, key }), { code: 'record-not-found' })
            }
            artifact.environments[env.key] = { entitySet: set, id: key, rows: [row] }
            const requested = columns ?? Object.keys(row).filter((name) => !name.startsWith('@')).slice(0, 8)
            const shown = reconcileColumns(requested, [row])
            return `${t('data.keySummary', { env: env.key, entity: logical, key, cost: costText(client.counters.requests, started) })}\n`
              + `${formatTable([row], shown.columns, { width: 40 })}${notesText(shown.notes)}`
            return
          }
          // Do not send `$top` here: `getPaged` asks for one row more than the
          // cap so a full page is distinguishable from a complete one.
          const params = {}
          if (filter) params.$filter = filter
          if (args.select) params.$select = args.select
          if (args.orderby) params.$orderby = args.orderby
          if (args.expand) params.$expand = args.expand
          const page = await client.getPaged(set, params, top, exec?.signal)
          const rows = page.records ?? []
          const counted = page.hasMore ? await countRows(client, set, filter, exec?.signal).catch(() => undefined) : { count: rows.length, capped: false }
          const total = counted?.count
          const requested = columns ?? Object.keys(rows[0] ?? {}).filter((name) => !name.startsWith('@')).slice(0, 8)
          const shown = reconcileColumns(requested, rows)
          artifact.environments[env.key] = { entitySet: set, params, total, capped: counted?.capped || undefined, rows }
          const cappedPart = counted?.capped ? t('data.totalCapped', { total }) : ''
          const head = total === undefined
            ? t('data.queryUnknownTotal', { env: env.key, entity: logical, count: rows.length })
            : total === rows.length
              ? t('data.queryTotal', { env: env.key, entity: logical, total })
              : t('data.queryPartial', { env: env.key, count: rows.length, total, capped: cappedPart })
          return `${head}${costText(client.counters.requests, started)}\n`
            + `${formatTable(rows, shown.columns, { width: 40 })}${notesText(shown.notes)}`
        }

        const top = Number.isFinite(args.top) ? Math.max(1, Math.min(100, args.top)) : 5
        const params = {}
        if (filter) params.$filter = filter
        if (args.select) params.$select = args.select
        const page = await client.getPaged(set, params, top, exec?.signal)
        const rows = page.records ?? []
        const requested = args.select
          ? args.select.split(',').map((item) => item.trim()).filter(Boolean)
          : Object.keys(rows[0] ?? {}).filter((name) => !name.startsWith('@')).slice(0, 5)
        const shown = reconcileColumns(requested, rows)
        artifact.environments[env.key] = { entitySet: set, rows, hasMore: page.hasMore }
        const more = page.hasMore ? t('data.sampleMore') : ''
        return `${t('data.sampleSummary', { env: env.key, entity: logical, count: rows.length, more, cost: costText(client.counters.requests, started) })}\n`
          + `${formatTable(rows, shown.columns, { width: 32 })}${notesText(shown.notes)}`
        } catch (error) {
          // One environment failing must not erase the others.
          return [
            t('data.queryFailed', { env: env.key }),
            `- ${error?.message ?? String(error)}`,
            error?.hint ? `- ${t('data.hintPrefix')}${error.hint}` : '',
          ].filter(Boolean).join('\n')
        }
      })

      const reports = blocks.filter(Boolean)
      const hasLargeResult = Object.values(artifact.environments).some((item) =>
        (item.rows?.length ?? item.groups?.length ?? 0) > INLINE_ROWS
        || item.rows?.some((row) => JSON.stringify(row).length > 4000))
      if (!hasLargeResult && action !== 'query' && action !== 'sample') {
        return { text: reports.join('\n\n') }
      }
      const file = await writeArtifact(config, `data-${action}`, artifact)
      return { text: `${reports.join('\n\n')}\n\n${t('data.fullResult', { file })}` }
    },
  })
}
