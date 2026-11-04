/**
 * Pending write plans and the change ledger.
 *
 * A plan is inert data. It becomes a change only when a person presses the
 * confirm button in the settings page, which then calls the Host's audited
 * execute route. The agent can create plans and read them; it cannot run one.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataRoot } from './snapshot.js'

const PLAN_ID = /^[0-9A-Za-z-]{6,64}$/

export function plansDir(config) {
  return join(dataRoot(config), 'pending-writes')
}

export function changesDir(config) {
  return join(dataRoot(config), 'changes')
}

function planPath(config, id) {
  if (!PLAN_ID.test(String(id ?? ''))) return undefined
  return join(plansDir(config), `${id}.json`)
}

/** Persist a plan and return it with its id. */
export async function createPlan(config, plan) {
  const id = plan.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const record = { ...plan, id, createdAt: new Date().toISOString(), status: 'pending' }
  const dir = plansDir(config)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return record
}

export async function readPlan(config, id) {
  const path = planPath(config, id)
  if (!path) return undefined
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

export async function deletePlan(config, id) {
  const path = planPath(config, id)
  if (!path) return false
  try {
    await rm(path)
    return true
  } catch {
    return false
  }
}

/**
 * Move a plan through its lifecycle: pending → running → done | failed.
 *
 * The file is the only guard against executing a plan twice. Marking it
 * "running" before the first write means a crash mid-plan leaves a record that
 * refuses a silent second run, instead of replaying the operations that already
 * landed.
 */
export async function setPlanStatus(config, id, status, extra = {}) {
  const plan = await readPlan(config, id)
  if (!plan) return undefined
  const path = planPath(config, id)
  if (!path) return undefined
  const next = { ...plan, ...extra, status, updatedAt: new Date().toISOString() }
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/** Every still-readable plan, newest first. */
export async function listPlans(config) {
  const dir = plansDir(config)
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const plans = []
  for (const name of names.filter((name) => name.endsWith('.json'))) {
    const plan = await readPlan(config, name.replace(/\.json$/, ''))
    if (plan) plans.push(plan)
  }
  return plans.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

/**
 * Append one executed change to the ledger. This file is the only record of
 * "what did the agent change and when", so it is written before the HTTP calls
 * settle and never rewritten.
 */
export async function recordChange(config, record) {
  const dir = changesDir(config)
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = `${stamp}-${record.planId ?? 'plan'}.json`
  const path = join(dir, name)
  await writeFile(path, `${JSON.stringify({ ...record, recordedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  return path
}

/** Recent ledger entries, newest first. */
export async function listChanges(config, limit = 20) {
  const dir = changesDir(config)
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const files = names.filter((name) => name.endsWith('.json')).sort().reverse().slice(0, limit)
  const entries = []
  for (const name of files) {
    try {
      entries.push(JSON.parse(await readFile(join(dir, name), 'utf8')))
    } catch {
      // A half-written ledger entry is skipped rather than failing the page.
    }
  }
  return entries
}

/**
 * Record how one publish attempt ended. One file per plan: a re-publish
 * overwrites the previous outcome, which is what "current state" means here.
 */
export async function writePublishReport(config, planId, record) {
  const dir = changesDir(config)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `publish-${planId}.json`)
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return path
}

/**
 * How the publish for each executed plan ended.
 *
 * The publish runs detached, so the ledger can only say "running"; the sidecar
 * written when the request settles is the only place that knows the outcome.
 * Keyed by planId so the plans panel can show it next to the change.
 */
export async function listPublishReports(config) {
  const dir = changesDir(config)
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return {}
  }
  const reports = {}
  for (const name of names.filter((name) => name.startsWith('publish-') && name.endsWith('.json'))) {
    try {
      const record = JSON.parse(await readFile(join(dir, name), 'utf8'))
      if (record?.planId) reports[record.planId] = record
    } catch {
      // Skip an unreadable sidecar; the UI falls back to the ledger state.
    }
  }
  return reports
}

