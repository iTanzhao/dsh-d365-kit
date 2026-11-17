/**
 * Pending write plans and the change ledger.
 *
 * A plan is inert data. It becomes a change only when a person presses the
 * confirm button in the settings page, which then calls the Host's audited
 * execute route. The agent can create plans and read them; it cannot run one.
 */
import { mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { D365Error } from './errors.js'
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

/** The lock is not a plan: `.lock` cannot match PLAN_ID, so no path confusion. */
function lockPath(config, id) {
  if (!PLAN_ID.test(String(id ?? ''))) return undefined
  return join(plansDir(config), `${id}.lock`)
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
 * Take exclusive ownership of a pending plan.
 *
 * Checking `status === 'pending'` and then writing is not a guard: two front
 * ends (the chat card and the settings page, or one page in two tabs) both read
 * "pending" and both proceed. Creating the lock with `wx` is atomic — exactly
 * one caller gets the file, and the other is told the plan is busy.
 *
 * @returns the lock path, to hand back to {@link releasePlan}.
 */
export async function claimPlan(config, id) {
  const path = lockPath(config, id)
  if (!path) throw new D365Error(`计划 id 不合法：${id}`, { code: 'bad-plan-id' })
  await mkdir(plansDir(config), { recursive: true })
  let handle
  try {
    handle = await open(path, 'wx')
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new D365Error(`计划 ${id} 正在执行`, {
        code: 'plan-busy',
        hint: '另一个窗口已经在执行这个计划。等它结束后刷新页面；如果确认上次执行没有完成，删除 .d365/pending-writes 下对应的 .lock 文件后再试。',
      })
    }
    throw error
  }
  try {
    await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, 'utf8')
  } finally {
    await handle.close()
  }
  return path
}

/** Give ownership back; safe to call when the lock is already gone. */
export async function releasePlan(config, id) {
  const path = lockPath(config, id)
  if (!path) return
  await rm(path, { force: true }).catch(() => {})
}

/**
 * Move a plan through its lifecycle: pending → running → done | failed.
 *
 * The file (plus the claim lock) is the guard against executing a plan twice.
 * Marking it "running" before the first write means a crash mid-plan leaves a
 * record that refuses a silent second run, instead of replaying the operations
 * that already landed.
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
 * Write one ledger entry. This file is the only record of "what did the agent
 * change and when", so the intent is written before the first HTTP call and the
 * same file is rewritten once with the outcome — a crash mid-plan leaves a
 * "running" entry instead of no trace at all.
 * @param path - the path returned by an earlier call, to update that entry.
 */
export async function recordChange(config, record, path) {
  const dir = changesDir(config)
  await mkdir(dir, { recursive: true })
  const target = path ?? join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${record.planId ?? 'plan'}.json`)
  await writeFile(target, `${JSON.stringify({ ...record, recordedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  return target
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
  // `publish-<planId>.json` sidecars live here too and sort after the
  // timestamped entries ("p" > "2"), so an unfiltered sort fills the newest
  // rows with publish reports and pushes the real ledger out of view.
  const files = names
    .filter((name) => name.endsWith('.json') && !name.startsWith('publish-'))
    .sort()
    .reverse()
    .slice(0, limit)
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

