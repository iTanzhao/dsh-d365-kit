/**
 * `d365_diff` — compare two metadata snapshots.
 *
 * Two shapes matter in practice: the same environment against its previous
 * snapshot ("what changed since last week") and one environment against another
 * ("what is in dev but not in sit"). Both are the same operation over two
 * directories, so this tool takes two snapshot references.
 *
 * Honesty about evidence is the whole point: when a resource was truncated or
 * failed to sync on one side, a "removed" row may simply never have been
 * fetched. Those resources are flagged rather than reported as removals.
 */
import { loadConfig } from './config.js'
import { KEY_FIELDS, DIFF_KEY_FIELDS, HIGHLIGHT_FIELDS, keyedRows } from './resources.js'
import { D365Error } from './errors.js'
import { listSnapshots, readResource, writeDiffReport } from './snapshot.js'
import { enforceRetention } from './retention.js'
import { t } from './i18n.js'

/** Display order for resources, most operationally interesting first. */
const RESOURCE_ORDER = [
  'organization',
  'solutions',
  'entities',
  'attributes',
  'forms',
  'views',
  'workflows',
  'plugin_steps',
  'plugin_assemblies',
  'plugin_types',
  'web_resources',
  'custom_apis',
  'solution_components',
  'sitemaps',
  'option_sets',
]

export const definition = {
  name: 'd365_diff',
  description:
    'Compare two D365 metadata snapshots and report added, removed, and changed fields. '
    + 'Supports previous-snapshot and cross-environment comparisons. When omitted, lists available snapshots. '
    + 'Use d365_snapshot first; use d365_contract for plug-in and option contracts, and d365_migrate for import impact.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      base: {
        type: 'string',
        description: 'Base snapshot: "dev" latest, "dev@prev" previous, or "dev@20261102T071005Z" exact. Omitted: previous snapshot of the head environment.',
      },
      head: {
        type: 'string',
        description: 'Comparison snapshot using the same syntax as base; defaults to the latest snapshot of the default environment.',
      },
      resources: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only compare these resources, such as ["entities","attributes"]; by default compare all resources captured on both sides.',
      },
      maxDetails: {
        type: 'integer',
        description: 'Maximum inline changes per resource, default 30; the full list is written to a report file.',
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

/** Parse `env`, `env@id`, `env@prev` or `env/id`. */
function parseRef(text) {
  const trimmed = String(text ?? '').trim()
  const match = /^([^@/]+)(?:[@/](.+))?$/.exec(trimmed)
  if (!match) throw new D365Error(t('diff.error.badRef', { ref: trimmed }), { code: 'bad-ref' })
  return { envKey: match[1].trim(), id: match[2]?.trim() }
}

/** Resolve one reference to `{ env, snapshot }`. */
async function resolveRef(config, text, role) {
  const { envKey, id } = parseRef(text)
  const env = config.environments[envKey]
  if (!env) {
    throw new D365Error(t('diff.error.unknownEnvironmentRole', { role, env: envKey }), {
      code: 'unknown-environment',
      hint: t('diff.error.available', { values: Object.keys(config.environments).join(', ') }),
    })
  }

  const snapshots = await listSnapshots(config, envKey)
  if (!snapshots.length) {
    throw new D365Error(t('diff.error.noSnapshot', { env: envKey }), {
      code: 'no-snapshot',
      hint: t('diff.hint.snapshot', { env: envKey }),
    })
  }

  if (!id || id === 'latest') return { env, snapshot: snapshots[0] }
  if (id === 'prev') {
    if (snapshots.length < 2) {
      throw new D365Error(t('diff.error.noPrevious', { env: envKey }), {
        code: 'no-previous',
        hint: t('diff.hint.previous'),
      })
    }
    return { env, snapshot: snapshots[1] }
  }

  const exact = snapshots.find((item) => item.id === id)
    ?? snapshots.find((item) => item.id.startsWith(id))
    // A time suffix is how people read these ids, so `@082604` should find
    // `20261102T082604Z`.
    ?? snapshots.find((item) => item.id.includes(id))
  if (!exact) {
    throw new D365Error(t('diff.error.snapshotMissing', { env: envKey, id }), {
      code: 'unknown-snapshot',
      hint: t('diff.error.existingSnapshots', { values: snapshots.slice(0, 8).map((item) => item.id).join(', ') }),
    })
  }
  return { env, snapshot: exact }
}

/** Normalize a cell for comparison. */
function normalize(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Fields that differ between any two environments for reasons that are not
 * drift: record GUIDs are minted per organization, metadata ids change on
 * import, and timestamps record when the row was touched. Comparing them turned
 * a real cross-environment report into "66051 web resources modified", which
 * buries the changes that matter.
 */
const NOISE_FIELDS = new Set([
  'metadataid',
  'modifiedon',
  'createdon',
  'installedon',
  'overwritetime',
  'msdyn_overwritetime',
  'modifiedby',
  'createdby',
  'overriddencreatedon',
  'timezoneruleversionnumber',
  'utcconversiontimezonecode',
  'versionnumber',
  'importsequencenumber',
])

function isNoiseField(field) {
  const lower = field.toLowerCase()
  if (NOISE_FIELDS.has(lower)) return true
  // Any `*id` column is a per-organization identifier; the row key already
  // carries identity, so its value never describes a difference in behaviour.
  return lower.endsWith('id')
}

/** Fields of a row worth comparing; `@odata` annotations are noise. */
function comparableFields(row) {
  return Object.keys(row ?? {}).filter(
    (key) => !key.startsWith('@') && !key.endsWith('@odata.etag') && !isNoiseField(key),
  )
}

/**
 * Resources whose rows cannot be aligned across organizations. `solution_components`
 * identifies a component by `objectid`, a GUID that is minted per environment, so
 * keying on it reports every component as added *and* removed. Counting per
 * `componenttype` is the honest question: "does the target have as many entities,
 * attributes, forms ... as the source".
 */
const HISTOGRAM_RESOURCES = new Set(['solution_components'])

/** Count rows per `componenttype` and diff the counts. */
function histogramDiff(baseRows, headRows, completeness = { base: true, head: true }) {
  const tally = (rows) => {
    const counts = new Map()
    for (const row of rows ?? []) {
      const key = String(row.componenttype ?? '?')
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }
  const baseCounts = tally(baseRows)
  const headCounts = tally(headRows)
  const changed = []
  const unconfirmedAdded = []
  const unconfirmedRemoved = []
  for (const key of new Set([...baseCounts.keys(), ...headCounts.keys()])) {
    const from = baseCounts.get(key) ?? 0
    const to = headCounts.get(key) ?? 0
    if (from === to) continue
    const label = t('diff.componentCountsLabel', { key, from, to })
    // An undercounted side cannot prove its count grew (or shrank).
    if (from < to && !completeness.base) {
      unconfirmedAdded.push({ key: label })
      continue
    }
    if (from > to && !completeness.head) {
      unconfirmedRemoved.push({ key: label })
      continue
    }
    changed.push({ key: `componenttype ${key}`, fields: [{ field: t('diff.count'), from: String(from), to: String(to) }] })
  }
  const sortByKey = (a, b) => a.key.localeCompare(b.key)
  return {
    keyFields: ['componenttype'],
    added: [],
    removed: [],
    changed: changed.sort(sortByKey),
    unconfirmedAdded: unconfirmedAdded.sort(sortByKey),
    unconfirmedRemoved: unconfirmedRemoved.sort(sortByKey),
    histogram: true,
  }
}

/**
 * Compare one resource's rows.
 *
 * `completeness` says whether each side is known to hold every row of this
 * resource. When it does not, a key present on one side only is not evidence of
 * an addition or removal — the row may simply never have been fetched — so it
 * lands in the unconfirmed buckets instead of the added/removed lists.
 * @returns `{ added, removed, changed, unconfirmedAdded, unconfirmedRemoved }`
 * with keys, plus the key fields used.
 */
function diffRows(resource, baseRows, headRows, completeness = { base: true, head: true }) {
  if (HISTOGRAM_RESOURCES.has(resource)) return histogramDiff(baseRows, headRows, completeness)

  const keyFields = DIFF_KEY_FIELDS[resource] ?? KEY_FIELDS[resource]
  const baseMap = keyedRows(resource, baseRows, keyFields)
  const headMap = keyedRows(resource, headRows, keyFields)

  const added = []
  const removed = []
  const changed = []
  const unconfirmedAdded = []
  const unconfirmedRemoved = []

  for (const [key, headRow] of headMap) {
    const baseRow = baseMap.get(key)
    if (!baseRow) {
      if (completeness.base) added.push({ key })
      else unconfirmedAdded.push({ key })
      continue
    }
    const fields = []
    const names = new Set([...comparableFields(baseRow), ...comparableFields(headRow)])
    for (const field of names) {
      const from = normalize(baseRow[field])
      const to = normalize(headRow[field])
      if (from !== to) fields.push({ field, from, to })
    }
    if (fields.length) changed.push({ key, fields })
  }
  for (const key of baseMap.keys()) {
    if (headMap.has(key)) continue
    if (completeness.head) removed.push({ key })
    else unconfirmedRemoved.push({ key })
  }

  const sortByKey = (a, b) => a.key.localeCompare(b.key)
  return {
    keyFields,
    added: added.sort(sortByKey),
    removed: removed.sort(sortByKey),
    changed: changed.sort(sortByKey),
    unconfirmedAdded: unconfirmedAdded.sort(sortByKey),
    unconfirmedRemoved: unconfirmedRemoved.sort(sortByKey),
  }
}

/** Order changed fields so the meaningful ones come first. */
function orderFields(resource, fields) {
  const highlight = HIGHLIGHT_FIELDS[resource] ?? []
  return [...fields].sort((a, b) => {
    const ai = highlight.indexOf(a.field)
    const bi = highlight.indexOf(b.field)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.field.localeCompare(b.field)
  })
}

/** A one-line description of one change. */
function describeChange(resource, change, maxFields = 6) {
  const fields = orderFields(resource, change.fields)
  const shown = fields.slice(0, maxFields).map((item) => `${item.field} ${item.from || '∅'}→${item.to || '∅'}`)
  if (fields.length > maxFields) shown.push(t('diff.moreFields', { count: fields.length - maxFields }))
  return `~ ${change.key}: ${shown.join(t('diff.listSeparator'))}`
}

/** Render the human-facing report, shared by the reply and the markdown file. */
function renderReport(context) {
  const { base, head, results, skipped, evidence, maxDetails } = context
  const lines = []
  const detailed = new Set()

  lines.push(t('diff.compare', {
    base: `${base.env.key}@${base.snapshot.id}`,
    head: `${head.env.key}@${head.snapshot.id}`,
  }))
  lines.push(t('diff.snapshots', {
    base: base.env.key,
    baseAt: base.snapshot.manifest.finishedAt ?? '?',
    baseState: t(base.snapshot.manifest.complete ? 'diff.complete' : 'diff.partial'),
    head: head.env.key,
    headAt: head.snapshot.manifest.finishedAt ?? '?',
    headState: t(head.snapshot.manifest.complete ? 'diff.complete' : 'diff.partial'),
  }))

  const staleHours = (manifest) => {
    const at = Date.parse(manifest?.finishedAt ?? '')
    if (!Number.isFinite(at)) return null
    return (Date.now() - at) / 3600000
  }
  const stale = [
    [t('diff.base'), base.env.key, staleHours(base.snapshot.manifest)],
    [t('diff.comparison'), head.env.key, staleHours(head.snapshot.manifest)],
  ].filter(([, , hours]) => hours !== null && hours > 24)
  if (stale.length) {
    lines.push('')
    lines.push(t('diff.staleHint', {
      values: stale.map(([role, env, hours]) => t('diff.staleItem', {
        role, env, hours: hours.toFixed(0),
      })).join(t('diff.separator')),
    }))
  }

  const totals = { added: 0, removed: 0, changed: 0, unknown: 0 }
  for (const result of results) {
    const { diff } = result
    totals.added += diff.added.length
    totals.removed += diff.removed.length
    totals.changed += diff.changed.length
    totals.unknown += (diff.unconfirmedAdded?.length ?? 0) + (diff.unconfirmedRemoved?.length ?? 0)
  }

  if (!totals.added && !totals.removed && !totals.changed && !totals.unknown) {
    lines.push('', t('diff.noDifferences'))
  } else {
    lines.push('', t('diff.tableHeader'), '| --- | --- | --- | --- | --- |')
    for (const result of results) {
      const { added, removed, changed } = result.diff
      const unknown = (result.diff.unconfirmedAdded?.length ?? 0) + (result.diff.unconfirmedRemoved?.length ?? 0)
      if (!added.length && !removed.length && !changed.length && !unknown) continue
      lines.push(`| ${result.resource} | ${added.length} | ${removed.length} | ${changed.length} | ${unknown} |`)
    }
  }

  for (const result of results) {
    const { added, removed, changed } = result.diff
    const unconfirmedAdded = result.diff.unconfirmedAdded ?? []
    const unconfirmedRemoved = result.diff.unconfirmedRemoved ?? []
    const unknown = unconfirmedAdded.length + unconfirmedRemoved.length
    if (!added.length && !removed.length && !changed.length && !unknown) continue
    lines.push('')
    const caveat = evidence.get(result.resource)?.caveat
    detailed.add(result.resource)
    const unknownPart = unknown ? t('diff.unknownPart', { count: unknown }) : ''
    lines.push(t('diff.resourceHeading', {
      resource: result.resource,
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unknown: unknownPart,
    }))
    if (caveat) lines.push(t('diff.note', { value: caveat }))
    if (unknown) lines.push(t('diff.incompleteNote'))

    for (const item of added.slice(0, maxDetails)) lines.push(`+ ${item.key}`)
    if (added.length > maxDetails) lines.push(t('diff.moreAdded', { count: added.length - maxDetails }))

    for (const item of removed.slice(0, maxDetails)) lines.push(`- ${item.key}`)
    if (removed.length > maxDetails) lines.push(t('diff.moreRemoved', { count: removed.length - maxDetails }))

    for (const item of changed.slice(0, maxDetails)) lines.push(describeChange(result.resource, item))
    if (changed.length > maxDetails) lines.push(t('diff.moreChanged', { count: changed.length - maxDetails }))

    for (const item of unconfirmedAdded.slice(0, maxDetails)) lines.push(`+ ? ${item.key}`)
    if (unconfirmedAdded.length > maxDetails) lines.push(t('diff.moreUnconfirmedAdded', { count: unconfirmedAdded.length - maxDetails }))

    for (const item of unconfirmedRemoved.slice(0, maxDetails)) lines.push(`- ? ${item.key}`)
    if (unconfirmedRemoved.length > maxDetails) lines.push(t('diff.moreUnconfirmedRemoved', { count: unconfirmedRemoved.length - maxDetails }))
  }

  if (skipped.length) {
    lines.push('', t('diff.skippedHeading'))
    for (const item of skipped) lines.push(`- ${item.resource}: ${item.reason}`)
  }

  const suspect = [...evidence.values()].filter((item) => item.caveat && !detailed.has(item.resource))
  if (suspect.length) {
    lines.push('', t('diff.incompleteResources'))
    for (const item of suspect) lines.push(`- ${item.resource}: ${item.caveat}`)
  }
  return lines
}

/** Explain why a resource's comparison may be misleading. */
function evidenceFor(resource, baseManifest, headManifest) {
  const baseDetail = baseManifest.resources?.[resource]
  const headDetail = headManifest.resources?.[resource]
  const parts = []
  if (baseDetail?.truncated) parts.push(t('diff.baseTruncated'))
  if (headDetail?.truncated) parts.push(t('diff.headTruncated'))
  if (baseDetail?.error) parts.push(t('diff.baseFailed', { error: String(baseDetail.error).slice(0, 80) }))
  if (headDetail?.error) parts.push(t('diff.headFailed', { error: String(headDetail.error).slice(0, 80) }))
  return parts.length ? { resource, caveat: parts.join(t('diff.separator')) } : null
}

/**
 * Whether each side holds every row of the resource, from the manifest detail
 * the sync run wrote. A missing detail is treated as incomplete: without a
 * record of the resource there is nothing to prove completeness with.
 */
function completenessFor(resource, baseManifest, headManifest) {
  const side = (manifest) => {
    const detail = manifest.resources?.[resource]
    return Boolean(detail) && !detail.truncated && !detail.error
  }
  return { base: side(baseManifest), head: side(headManifest) }
}

/** List available snapshots, newest first. */
async function describeSnapshots(config) {
  const lines = [t('diff.snapshotsHeading')]
  let total = 0
  for (const envKey of Object.keys(config.environments)) {
    const snapshots = await listSnapshots(config, envKey)
    if (!snapshots.length) {
      lines.push(t('diff.snapshotNone', { env: envKey }))
      continue
    }
    total += snapshots.length
    for (const snapshot of snapshots.slice(0, 5)) {
      const manifest = snapshot.manifest
      const orgName = manifest.organization?.name ?? '?'
      const state = manifest.complete ? t('diff.complete') : t('diff.partial')
      const resources = Object.keys(manifest.resources ?? {}).length
      lines.push(t('diff.snapshotLine', {
        env: envKey,
        id: snapshot.id,
        org: orgName,
        state,
        resources,
        at: manifest.finishedAt ?? '',
      }))
    }
    if (snapshots.length > 5) lines.push(t('diff.moreSnapshots', { env: envKey, count: snapshots.length - 5 }))
  }
  if (total) lines.push('', t('diff.usage'))
  return lines.join('\n')
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args = {}) {
      const config = await loadConfig(state.rawConfig)

      if (!args.base && !args.head) {
        return { text: await describeSnapshots(config) }
      }

      const head = await resolveRef(config, args.head ?? config.defaultEnvironment, 'head')
      const base = await resolveRef(config, args.base ?? `${head.env.key}@prev`, 'base')

      const baseResources = new Set(Object.keys(base.snapshot.manifest.resources ?? {}))
      const headResources = new Set(Object.keys(head.snapshot.manifest.resources ?? {}))
      const requested = Array.isArray(args.resources) && args.resources.length
        ? args.resources
        // `organization` is the environment's own identity: two environments are
        // always "different" there, and that says nothing about drift.
        : RESOURCE_ORDER.filter((resource) => resource !== 'organization'
          && baseResources.has(resource) && headResources.has(resource))

      const ordered = [...requested].sort(
        (a, b) => (RESOURCE_ORDER.indexOf(a) === -1 ? 99 : RESOURCE_ORDER.indexOf(a))
          - (RESOURCE_ORDER.indexOf(b) === -1 ? 99 : RESOURCE_ORDER.indexOf(b)),
      )

      const results = []
      const skipped = []
      const evidence = new Map()

      for (const resource of ordered) {
        const inBase = baseResources.has(resource)
        const inHead = headResources.has(resource)
        if (!inBase || !inHead) {
          skipped.push({
            resource,
            reason: !inBase && !inHead
              ? t('diff.bothNotCaptured')
              : inBase ? t('diff.headNotCaptured') : t('diff.baseNotCaptured'),
          })
          continue
        }
        const basePayload = await readResource(config, base.env.key, base.snapshot.id, resource)
        const headPayload = await readResource(config, head.env.key, head.snapshot.id, resource)
        if (!basePayload || !headPayload) {
          skipped.push({ resource, reason: t('diff.snapshotFileMissing') })
          continue
        }
        const diff = diffRows(
          resource,
          basePayload.rows ?? [],
          headPayload.rows ?? [],
          completenessFor(resource, base.snapshot.manifest, head.snapshot.manifest),
        )
        results.push({ resource, diff })
        const flag = evidenceFor(resource, base.snapshot.manifest, head.snapshot.manifest) ?? {}
        if (diff.histogram) {
          flag.caveat = [flag.caveat, t('diff.histogramCaveat')]
            .filter(Boolean).join(t('diff.separator'))
        }
        if (flag.caveat) evidence.set(resource, { resource, caveat: flag.caveat })
      }

      const maxDetails = Number.isFinite(args.maxDetails) && args.maxDetails > 0
        ? Math.min(200, Math.trunc(args.maxDetails))
        : 30

      const lines = renderReport({ base, head, ordered, results, skipped, evidence, maxDetails })

      const changedResources = results.filter(
        (result) => result.diff.added.length || result.diff.removed.length || result.diff.changed.length
          || result.diff.unconfirmedAdded?.length || result.diff.unconfirmedRemoved?.length,
      )
      if (changedResources.length || skipped.length) {
        const markdown = renderReport({ base, head, ordered, results, skipped, evidence, maxDetails: 500 }).join('\n')
        const file = await writeDiffReport(
          config,
          `${base.env.key}-${base.snapshot.id}-vs-${head.env.key}-${head.snapshot.id}`,
          `# ${t('diff.reportTitle')}\n\n${markdown}\n`,
        )
        lines.push('', t('diff.fullReport', { file }))
        await enforceRetention(config, { target: 'diffs' })
      }

      return { text: lines.join('\n') }
    },
    presentCall(args = {}) {
      const title = args.base || args.head
        ? t('diff.callCompare', {
          base: args.base ?? t('diff.previous'),
          head: args.head ?? t('diff.latest'),
        })
        : t('diff.callList')
      return { card: 'generic', title, kind: 'other', rawInput: args }
    },
  })
}
