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
import { KEY_FIELDS, DIFF_KEY_FIELDS, HIGHLIGHT_FIELDS, rowKey } from './resources.js'
import { D365Error } from './errors.js'
import { listSnapshots, readResource, writeDiffReport } from './snapshot.js'
import { enforceRetention } from './retention.js'

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
    '比较两份 D365 元数据快照，给出新增 / 删除 / 修改（字段级）。'
    + '可用于"同一环境与上一份快照对比"或"dev 与 sit 对比"。'
    + '参数省略时先列出各环境已有快照，便于先 d365_sync 再对比。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      base: {
        type: 'string',
        description: '基准快照："dev" 表示 dev 最新，"dev@prev" 表示上一份，"dev@20261102T071005Z" 指定某份。省略时取 head 环境的上一份快照。',
      },
      head: {
        type: 'string',
        description: '对照快照，写法同 base。省略时取默认环境的最新快照。',
      },
      resources: {
        type: 'array',
        items: { type: 'string' },
        description: '只比较这些资源，例如 ["entities","attributes"]。默认比较两边都采集过的全部资源。',
      },
      maxDetails: {
        type: 'integer',
        description: '每个资源在回复里最多列多少条变化，默认 30；完整清单写入报告文件。',
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
  if (!match) throw new D365Error(`无法解析快照引用：${trimmed}`, { code: 'bad-ref' })
  return { envKey: match[1].trim(), id: match[2]?.trim() }
}

/** Resolve one reference to `{ env, snapshot }`. */
async function resolveRef(config, text, role) {
  const { envKey, id } = parseRef(text)
  const env = config.environments[envKey]
  if (!env) {
    throw new D365Error(`${role} 引用了未知环境：${envKey}`, {
      code: 'unknown-environment',
      hint: `可用环境：${Object.keys(config.environments).join(', ')}`,
    })
  }

  const snapshots = await listSnapshots(config, envKey)
  if (!snapshots.length) {
    throw new D365Error(`环境 ${envKey} 还没有任何快照`, {
      code: 'no-snapshot',
      hint: `先运行 d365_sync（environments: ["${envKey}"]）。`,
    })
  }

  if (!id || id === 'latest') return { env, snapshot: snapshots[0] }
  if (id === 'prev') {
    if (snapshots.length < 2) {
      throw new D365Error(`环境 ${envKey} 只有一份快照，没有"上一份"可对比`, {
        code: 'no-previous',
        hint: '再跑一次 d365_sync，或显式指定另一份快照 ID。',
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
    throw new D365Error(`找不到快照 ${envKey}@${id}`, {
      code: 'unknown-snapshot',
      hint: `该环境现有：${snapshots.slice(0, 8).map((item) => item.id).join(', ')}`,
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
  'objecttypecode',
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
function histogramDiff(baseRows, headRows) {
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
  for (const key of new Set([...baseCounts.keys(), ...headCounts.keys()])) {
    const from = baseCounts.get(key) ?? 0
    const to = headCounts.get(key) ?? 0
    if (from === to) continue
    changed.push({ key: `componenttype ${key}`, fields: [{ field: '数量', from: String(from), to: String(to) }] })
  }
  changed.sort((a, b) => a.key.localeCompare(b.key))
  return { keyFields: ['componenttype'], added: [], removed: [], changed, histogram: true }
}

/**
 * Compare one resource's rows.
 * @returns `{ added, removed, changed }` with keys, plus the key fields used.
 */
function diffRows(resource, baseRows, headRows) {
  if (HISTOGRAM_RESOURCES.has(resource)) return histogramDiff(baseRows, headRows)

  const keyFields = DIFF_KEY_FIELDS[resource] ?? KEY_FIELDS[resource]
  const keyOf = (row) => rowKey(resource, row, keyFields)

  const baseMap = new Map()
  for (const row of baseRows) baseMap.set(keyOf(row), row)
  const headMap = new Map()
  for (const row of headRows) headMap.set(keyOf(row), row)

  const added = []
  const removed = []
  const changed = []

  for (const [key, headRow] of headMap) {
    const baseRow = baseMap.get(key)
    if (!baseRow) {
      added.push({ key })
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
    if (!headMap.has(key)) removed.push({ key })
  }

  const sortByKey = (a, b) => a.key.localeCompare(b.key)
  return {
    keyFields,
    added: added.sort(sortByKey),
    removed: removed.sort(sortByKey),
    changed: changed.sort(sortByKey),
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
  if (fields.length > maxFields) shown.push(`… 另有 ${fields.length - maxFields} 个字段`)
  return `~ ${change.key}：${shown.join('；')}`
}

/** Render the human-facing report, shared by the reply and the markdown file. */
function renderReport(context) {
  const { base, head, results, skipped, evidence, maxDetails } = context
  const lines = []
  const detailed = new Set()

  lines.push(`比较：${base.env.key}@${base.snapshot.id} → ${head.env.key}@${head.snapshot.id}`)
  lines.push(
    `基准：${base.env.key}（${base.snapshot.manifest.finishedAt ?? '?'}，${base.snapshot.manifest.complete ? '完整' : '部分'}）`
    + `；对照：${head.env.key}（${head.snapshot.manifest.finishedAt ?? '?'}，${head.snapshot.manifest.complete ? '完整' : '部分'}）`,
  )

  const staleHours = (manifest) => {
    const at = Date.parse(manifest?.finishedAt ?? '')
    if (!Number.isFinite(at)) return null
    return (Date.now() - at) / 3600000
  }
  const stale = [
    ['基准', base.env.key, staleHours(base.snapshot.manifest)],
    ['对照', head.env.key, staleHours(head.snapshot.manifest)],
  ].filter(([, , hours]) => hours !== null && hours > 24)
  if (stale.length) {
    lines.push('')
    lines.push(`提示：${stale.map(([role, env, hours]) => `${role}快照（${env}）已是 ${hours.toFixed(0)} 小时前`).join('，')}，元数据可能已经变了；建议先 \`d365_sync\` 再比较。`)
  }

  const totals = { added: 0, removed: 0, changed: 0 }
  for (const result of results) {
    totals.added += result.diff.added.length
    totals.removed += result.diff.removed.length
    totals.changed += result.diff.changed.length
  }

  if (!totals.added && !totals.removed && !totals.changed) {
    lines.push('', '两份快照在已采集的资源上没有差异。')
  } else {
    lines.push('')
    lines.push('| 资源 | 新增 | 删除 | 修改 |')
    lines.push('| --- | --- | --- | --- |')
    for (const result of results) {
      const { added, removed, changed } = result.diff
      if (!added.length && !removed.length && !changed.length) continue
      lines.push(`| ${result.resource} | ${added.length} | ${removed.length} | ${changed.length} |`)
    }
  }

  for (const result of results) {
    const { added, removed, changed } = result.diff
    if (!added.length && !removed.length && !changed.length) continue
    lines.push('')
    const caveat = evidence.get(result.resource)?.caveat
    detailed.add(result.resource)
    lines.push(`### ${result.resource}（新增 ${added.length} / 删除 ${removed.length} / 修改 ${changed.length}）`)
    if (caveat) lines.push(`> 注意：${caveat}`)

    for (const item of added.slice(0, maxDetails)) lines.push(`+ ${item.key}`)
    if (added.length > maxDetails) lines.push(`+ … 其余 ${added.length - maxDetails} 条见报告文件`)

    for (const item of removed.slice(0, maxDetails)) lines.push(`- ${item.key}`)
    if (removed.length > maxDetails) lines.push(`- … 其余 ${removed.length - maxDetails} 条见报告文件`)

    for (const item of changed.slice(0, maxDetails)) lines.push(describeChange(result.resource, item))
    if (changed.length > maxDetails) lines.push(`~ … 其余 ${changed.length - maxDetails} 条见报告文件`)
  }

  if (skipped.length) {
    lines.push('')
    lines.push('未参与比较的资源（有一侧没采集）：')
    for (const item of skipped) lines.push(`- ${item.resource}：${item.reason}`)
  }

  // Resources with no visible diff but incomplete data need their own warning,
  // otherwise a partial snapshot reads as "nothing changed".
  const suspect = [...evidence.values()].filter((item) => item.caveat && !detailed.has(item.resource))
  if (suspect.length) {
    lines.push('')
    lines.push('其余资源数据不完整，未发现差异不代表没有变化：')
    for (const item of suspect) lines.push(`- ${item.resource}：${item.caveat}`)
  }
  return lines
}

/** Explain why a resource's comparison may be misleading. */
function evidenceFor(resource, baseManifest, headManifest) {
  const baseDetail = baseManifest.resources?.[resource]
  const headDetail = headManifest.resources?.[resource]
  const parts = []
  if (baseDetail?.truncated) parts.push('基准侧被行数上限截断')
  if (headDetail?.truncated) parts.push('对照侧被行数上限截断')
  if (baseDetail?.error) parts.push(`基准侧采集失败（${String(baseDetail.error).slice(0, 80)}）`)
  if (headDetail?.error) parts.push(`对照侧采集失败（${String(headDetail.error).slice(0, 80)}）`)
  return parts.length ? { resource, caveat: parts.join('；') } : null
}

/** List available snapshots, newest first. */
async function describeSnapshots(config) {
  const lines = ['当前已有快照（最新在前）：']
  let total = 0
  for (const envKey of Object.keys(config.environments)) {
    const snapshots = await listSnapshots(config, envKey)
    if (!snapshots.length) {
      lines.push(`- ${envKey}：无（先运行 d365_sync）`)
      continue
    }
    total += snapshots.length
    for (const snapshot of snapshots.slice(0, 5)) {
      const manifest = snapshot.manifest
      const orgName = manifest.organization?.name ?? '?'
      const state = manifest.complete ? '完整' : '部分'
      const resources = Object.keys(manifest.resources ?? {}).length
      lines.push(`- ${envKey}@${snapshot.id}：${orgName}，${state}，${resources} 个资源，${manifest.finishedAt ?? ''}`)
    }
    if (snapshots.length > 5) lines.push(`- ${envKey}：其余 ${snapshots.length - 5} 份略`)
  }
  if (total) {
    lines.push('')
    lines.push('对比用法：base="dev@prev" head="dev"（同一环境与上一份），或 base="dev" head="sit"（跨环境）。')
  }
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
            reason: !inBase && !inHead ? '两侧都未采集' : inBase ? '对照侧未采集' : '基准侧未采集',
          })
          continue
        }
        const basePayload = await readResource(config, base.env.key, base.snapshot.id, resource)
        const headPayload = await readResource(config, head.env.key, head.snapshot.id, resource)
        if (!basePayload || !headPayload) {
          skipped.push({ resource, reason: '快照文件缺失' })
          continue
        }
        const diff = diffRows(resource, basePayload.rows ?? [], headPayload.rows ?? [])
        results.push({ resource, diff })
        const flag = evidenceFor(resource, base.snapshot.manifest, head.snapshot.manifest) ?? {}
        if (diff.histogram) {
          flag.caveat = [flag.caveat, '按 componenttype 计数比较（组件的 objectid 是按组织分配的 GUID，逐行对齐会得到全部新增+全部删除）']
            .filter(Boolean).join('；')
        }
        if (flag.caveat) evidence.set(resource, { resource, caveat: flag.caveat })
      }

      const maxDetails = Number.isFinite(args.maxDetails) && args.maxDetails > 0
        ? Math.min(200, Math.trunc(args.maxDetails))
        : 30

      const lines = renderReport({ base, head, ordered, results, skipped, evidence, maxDetails })

      const changedResources = results.filter(
        (result) => result.diff.added.length || result.diff.removed.length || result.diff.changed.length,
      )
      if (changedResources.length || skipped.length) {
        const markdown = renderReport({ base, head, ordered, results, skipped, evidence, maxDetails: 500 }).join('\n')
        const file = await writeDiffReport(
          config,
          `${base.env.key}-${base.snapshot.id}-vs-${head.env.key}-${head.snapshot.id}`,
          `# D365 元数据差异\n\n${markdown}\n`,
        )
        lines.push('', `完整报告：${file}`)
        await enforceRetention(config, { target: 'diffs' })
      }

      return { text: lines.join('\n') }
    },
    presentCall(args = {}) {
      const title = args.base || args.head
        ? `比较快照 ${args.base ?? '（上一份）'} → ${args.head ?? '（最新）'}`
        : '列出已有 D365 快照'
      return { card: 'generic', title, kind: 'other', rawInput: args }
    },
  })
}
