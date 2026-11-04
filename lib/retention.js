/**
 * Retention and storage hygiene for everything under `.d365/`.
 *
 * The rules are deliberately boring: keep the newest N of each class, plus a
 * maximum age as a second net. Deletions are always planned first, then applied
 * through a path guard that refuses anything outside the class directory, and
 * a few files are never touched at all (waivers, plans, config, secrets).
 */

import { readdir, rm, stat, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { dataRoot, listSnapshots, snapshotsRoot } from './snapshot.js'
import { DEFAULT_RETENTION } from './retention-defaults.js'

export const DAY_MS = 24 * 60 * 60 * 1000

/** Files that must survive every cleanup, by class. */
const PROTECTED = {
  reports: new Set(['contract-history.json']),
}

export { DEFAULT_RETENTION }

export const CLASSES = [
  {
    id: 'snapshots',
    label: '元数据快照',
    keepKey: 'snapshotKeep',
    daysKey: 'snapshotMaxAgeDays',
    minKeep: 1,
    perEnvironment: true,
    hint: '每个环境至少保留一份；最新一份永远不会被删。',
  },
  {
    id: 'reports',
    label: '分析报告',
    keepKey: 'reportKeep',
    daysKey: 'reportMaxAgeDays',
    minKeep: 1,
    hint: '契约漂移、代码检查、迁移评估的报告；趋势文件永不删除。',
  },
  {
    id: 'diffs',
    label: '快照差异报告',
    keepKey: 'diffKeep',
    daysKey: 'diffMaxAgeDays',
    minKeep: 0,
  },
  {
    id: 'query',
    label: '查询留证',
    keepKey: 'queryKeep',
    daysKey: 'queryMaxAgeDays',
    minKeep: 0,
    hint: '各工具“本次查询结果”的留证；通常最大也最不值钱。',
  },
  {
    id: 'changes',
    label: '写入审计',
    keepKey: 'changeKeep',
    daysKey: 'changeMaxAgeDays',
    minKeep: 1,
    hint: '每次执行写入的 ledger，建议比其它类留得久。',
  },
]

function numberOr(value, fallback, min) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback
}

/** Retention policy for one config, with defaults filled in. */
export function retentionPolicy(config) {
  const source = config ?? {}
  const policy = {}
  for (const [key, fallback] of Object.entries(DEFAULT_RETENTION)) {
    const min = key === 'warnMegabytes' ? 50 : key.endsWith('Keep') ? 0 : 1
    policy[key] = numberOr(source[key], fallback, min)
  }
  return policy
}

function classDirectory(config, id) {
  return join(dataRoot(config), id)
}

function within(directory, target) {
  const base = resolve(directory)
  const full = resolve(target)
  return full === base || full.startsWith(base + sep)
}

async function sizeOf(path) {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : 0
  } catch {
    return 0
  }
}

async function listEntries(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const rows = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (!entry.isFile() && !entry.isDirectory()) continue
    let info
    try {
      info = await stat(path)
    } catch {
      continue
    }
    let bytes = info.size
    if (entry.isDirectory()) {
      bytes = 0
      try {
        for (const child of await readdir(path, { withFileTypes: true })) {
          if (child.isFile()) bytes += await sizeOf(join(path, child.name))
        }
      } catch {
        bytes = 0
      }
    }
    rows.push({ name: entry.name, path, bytes, modifiedAt: info.mtime })
  }
  return rows.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

async function snapshotEntries(config) {
  const root = snapshotsRoot(config)
  let environments = []
  try {
    environments = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory())
  } catch {
    return []
  }
  const rows = []
  for (const env of environments) {
    const snapshots = await listSnapshots(config, env.name)
    for (const snapshot of snapshots) {
      let bytes = 0
      try {
        for (const child of await readdir(snapshot.dir, { withFileTypes: true })) {
          if (child.isFile()) bytes += await sizeOf(join(snapshot.dir, child.name))
        }
      } catch {
        bytes = 0
      }
      rows.push({
        name: `${env.name}/${snapshot.id}`,
        group: env.name,
        path: snapshot.dir,
        bytes,
        modifiedAt: new Date(snapshot.manifest?.finishedAt ?? snapshot.manifest?.startedAt ?? Date.now()),
      })
    }
  }
  return rows.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

/** Summary of what is on disk, per class. */
export async function storageSummary(config) {
  const policy = retentionPolicy(config)
  const classes = []
  let totalBytes = 0

  for (const definition of CLASSES) {
    const rows = definition.id === 'snapshots'
      ? await snapshotEntries(config)
      : await listEntries(classDirectory(config, definition.id))

    const bytes = rows.reduce((sum, row) => sum + row.bytes, 0)
    totalBytes += bytes
    const protectedNames = PROTECTED[definition.id] ?? new Set()
    const eligible = rows.filter((row) => !protectedNames.has(row.name))

    classes.push({
      id: definition.id,
      label: definition.label,
      hint: definition.hint ?? '',
      count: rows.length,
      bytes,
      oldestAt: eligible.length ? eligible[eligible.length - 1].modifiedAt.toISOString() : '',
      newestAt: eligible.length ? eligible[0].modifiedAt.toISOString() : '',
      keep: policy[definition.keepKey],
      maxAgeDays: policy[definition.daysKey],
      perEnvironment: definition.perEnvironment === true,
    })
  }

  return {
    totalBytes,
    warnMegabytes: policy.warnMegabytes,
    overLimit: totalBytes > policy.warnMegabytes * 1024 * 1024,
    classes,
    policy,
  }
}

/**
 * Dry-run what a cleanup would remove.
 * @param options - `{ target }` where target is a class id or 'all'.
 */
export async function planCleanup(config, options = {}) {
  const policy = retentionPolicy(config)
  const target = options.target ?? 'all'
  const now = options.now ? new Date(options.now) : new Date()
  const classes = []
  let totalBytes = 0

  for (const definition of CLASSES) {
    if (target !== 'all' && target !== definition.id) continue
    const keep = policy[definition.keepKey]
    const maxAgeDays = policy[definition.daysKey]
    const rows = definition.id === 'snapshots'
      ? await snapshotEntries(config)
      : await listEntries(classDirectory(config, definition.id))
    const protectedNames = PROTECTED[definition.id] ?? new Set()

    const remove = []
    const groups = definition.perEnvironment
      ? [...new Set(rows.map((row) => row.group))].map((group) => rows.filter((row) => row.group === group))
      : [rows]

    for (const group of groups) {
      // `rows` is newest-first; per environment the first `keep` survive.
      group.forEach((row, index) => {
        if (protectedNames.has(row.name)) return
        const ageDays = (now.getTime() - row.modifiedAt.getTime()) / DAY_MS
        const overCount = index >= keep
        const overAge = ageDays > maxAgeDays && index >= definition.minKeep
        if (overCount || overAge) {
          remove.push({ name: row.name, path: row.path, bytes: row.bytes, ageDays: Math.round(ageDays) })
        }
      })
    }

    const bytes = remove.reduce((sum, row) => sum + row.bytes, 0)
    totalBytes += bytes
    classes.push({
      id: definition.id,
      label: definition.label,
      keep,
      maxAgeDays,
      count: rows.length,
      remove: remove.sort((a, b) => b.ageDays - a.ageDays),
      bytes,
    })
  }

  return { target, totalBytes, totalFiles: classes.reduce((sum, row) => sum + row.remove.length, 0), classes }
}

/**
 * Delete what a plan says to delete. Every path is re-checked against its class
 * directory, so a malformed plan entry can never escape `.d365/`.
 */
export async function applyCleanup(config, plan) {
  const deleted = []
  const failures = []
  let bytes = 0

  for (const item of plan.classes ?? []) {
    const directory = item.id === 'snapshots'
      ? snapshotsRoot(config)
      : classDirectory(config, item.id)
    for (const file of item.remove ?? []) {
      if (!within(directory, file.path)) {
        failures.push({ name: file.name, reason: '路径不在允许的目录内' })
        continue
      }
      try {
        await rm(file.path, { recursive: true, force: true })
        deleted.push({ class: item.id, name: file.name })
        bytes += file.bytes ?? 0
      } catch (error) {
        failures.push({ name: file.name, reason: error?.message ?? String(error) })
      }
    }
  }

  return { deleted, failures, bytes }
}

/**
 * Apply the policy silently. Called after a tool writes its artifact, so the
 * directory never grows without bound. Failures are swallowed: retention must
 * never break a real operation.
 */
export async function enforceRetention(config, options = {}) {
  try {
    const plan = await planCleanup(config, { target: options.target ?? 'all' })
    if (!plan.totalFiles) return { deleted: 0, bytes: 0 }
    const applied = await applyCleanup(config, plan)
    return { deleted: applied.deleted.length, bytes: applied.bytes }
  } catch {
    return { deleted: 0, bytes: 0 }
  }
}

/** Compact one snapshot's resource files (pretty JSON → single line). */export async function compactSnapshot(config, envKey, id) {
  const snapshots = await listSnapshots(config, envKey)
  const snapshot = snapshots.find((item) => item.id === id)
  if (!snapshot) return { files: 0, savedBytes: 0 }
  let files = 0
  let savedBytes = 0
  for (const name of await readdir(snapshot.dir)) {
    if (!name.endsWith('.json') || name === 'manifest.json') continue
    const path = join(snapshot.dir, name)
    try {
      const text = await readFile(path, 'utf8')
      const payload = JSON.parse(text)
      const compact = `${JSON.stringify(payload)}\n`
      if (compact.length < text.length) {
        savedBytes += text.length - compact.length
        await writeFile(path, compact, 'utf8')
        files += 1
      }
    } catch {
      // A snapshot file that no longer parses is left alone.
    }
  }
  return { files, savedBytes }
}

/** Compact every snapshot on disk. */
export async function compactAllSnapshots(config) {
  const policyReport = { snapshots: 0, files: 0, savedBytes: 0 }
  for (const row of await snapshotEntries(config)) {
    const [envKey, id] = row.name.split('/')
    const result = await compactSnapshot(config, envKey, id)
    policyReport.snapshots += 1
    policyReport.files += result.files
    policyReport.savedBytes += result.savedBytes
  }
  return policyReport
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}
