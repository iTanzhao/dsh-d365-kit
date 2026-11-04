/**
 * Snapshot storage.
 *
 * A snapshot is a directory that becomes visible only when its `manifest.json`
 * exists: resource files are written first and the manifest last, so an
 * interrupted sync leaves an orphan directory that no reader ever picks up.
 *
 * The manifest is also what makes a snapshot trustworthy: it records, per
 * resource, whether the pull was complete, truncated by the row cap, or failed.
 * Without that, "the environment does not have this" and "we never fetched it"
 * would look identical in a diff.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { dataDirectory } from './config.js'

/** Root directory holding snapshots, diffs and query artifacts. */
export function dataRoot(config) {
  return join(dataDirectory(config), '.d365')
}

export function snapshotsRoot(config) {
  return join(dataRoot(config), 'snapshots')
}

export function diffsRoot(config) {
  return join(dataRoot(config), 'diffs')
}

/** Sortable, filename-safe snapshot id: `20261102T071005Z`. */
export function snapshotId(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

export function envSnapshotDir(config, envKey, id) {
  return join(snapshotsRoot(config), envKey, id)
}

/**
 * Ensure the data root exists and carries a `.gitignore`, so a metadata dump
 * of a customer org never gets committed by accident.
 */
export async function ensureDataRoot(config) {
  const root = dataRoot(config)
  await mkdir(root, { recursive: true })
  await writeFile(
    join(root, '.gitignore'),
    '# D365 snapshots and query artifacts may contain customer metadata.\n*\n',
    { flag: 'wx' },
  ).catch(() => {})
  return root
}

/**
 * Write one snapshot: resource files first, manifest last.
 * @param files - array of `{ resource, payload }`.
 * @returns the snapshot directory.
 */
export async function writeSnapshot(config, envKey, id, manifest, files) {
  const dir = envSnapshotDir(config, envKey, id)
  await mkdir(dir, { recursive: true })
  for (const file of files) {
    // Compact JSON: a 200k-row resource is ~35% smaller without indentation,
    // and nothing reads these files by eye.
    await writeFile(join(dir, `${file.resource}.json`), `${JSON.stringify(file.payload)}\n`, 'utf8')
  }
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return dir
}

/**
 * List snapshots of one environment, newest first. Only directories with a
 * manifest count — the rest are interrupted writes.
 * @returns `[{ id, dir, manifest }]`.
 */
export async function listSnapshots(config, envKey) {
  const dir = join(snapshotsRoot(config), envKey)
  let names
  try {
    names = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const snapshots = []
  for (const entry of names) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(dir, entry.name, 'manifest.json')
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      snapshots.push({ id: entry.name, dir: join(dir, entry.name), manifest })
    } catch {
      continue
    }
  }
  return snapshots.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

/** Read a manifest, or null when the snapshot does not exist. */
export async function readManifest(config, envKey, id) {
  try {
    const text = await readFile(join(envSnapshotDir(config, envKey, id), 'manifest.json'), 'utf8')
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Read one resource's rows from a snapshot, or null when it was not synced. */
export async function readResource(config, envKey, id, resource) {
  try {
    const text = await readFile(join(envSnapshotDir(config, envKey, id), `${resource}.json`), 'utf8')
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Delete the oldest snapshots beyond `keep`, inside one environment only.
 * Refuses any path that resolves outside the environment's snapshot directory.
 * @returns the deleted ids.
 */
export async function pruneSnapshots(config, envKey, keep) {
  if (!Number.isFinite(keep) || keep < 1) return []
  const snapshots = await listSnapshots(config, envKey)
  if (snapshots.length <= keep) return []

  const base = resolve(join(snapshotsRoot(config), envKey))
  const deleted = []
  for (const snapshot of snapshots.slice(keep)) {
    const target = resolve(snapshot.dir)
    if (target !== base && target.startsWith(base + sep)) {
      await rm(target, { recursive: true, force: true })
      deleted.push(snapshot.id)
    }
  }
  return deleted
}

/** Write a diff report and return its workspace-relative path. */
export async function writeDiffReport(config, name, markdown) {
  const root = diffsRoot(config)
  await mkdir(root, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(root, `${stamp}-${name.replace(/[^a-zA-Z0-9._-]+/g, '-')}.md`)
  await writeFile(file, `${markdown}\n`, 'utf8')
  return file.replace(/\\/g, '/')
}
