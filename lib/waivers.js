/**
 * Waivers: differences a team has decided to accept.
 *
 * A waiver is data, not code — it lives in `<data dir>/waivers.json` so it can
 * be reviewed in a pull request. Every waiver must carry a reason and an expiry:
 * an accepted difference that never expires is just a forgotten one.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dataRoot } from './snapshot.js'

export function waiversPath(config) {
  return join(dataRoot(config), 'waivers.json')
}

const EMPTY = { waivers: [] }

export async function readWaivers(config) {
  try {
    const text = await readFile(waiversPath(config), 'utf8')
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
    return Array.isArray(parsed?.waivers) ? parsed : EMPTY
  } catch (error) {
    if (error?.code === 'ENOENT') return EMPTY
    throw error
  }
}

export async function writeWaivers(config, document) {
  const path = waiversPath(config)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(document, null, 2), 'utf8')
}

/** Add or replace a waiver (same rule + env + object). */
export async function addWaiver(config, entry) {
  const document = await readWaivers(config)
  const key = `${entry.rule}|${entry.env}|${entry.object}`
  document.waivers = document.waivers.filter(
    (item) => `${item.rule}|${item.env}|${item.object}` !== key,
  )
  document.waivers.push(entry)
  await writeWaivers(config, document)
  return document.waivers
}

export function isExpired(waiver, now = Date.now()) {
  if (!waiver.expiresAt) return false
  const at = Date.parse(waiver.expiresAt)
  return Number.isFinite(at) && at < now
}

/** `*` matches everything, a trailing `*` matches a prefix. */
export function matchesWaiver(waiver, finding) {
  if (waiver.rule !== finding.rule) return false
  if (waiver.env !== '*' && waiver.env !== finding.env) return false
  const object = String(waiver.object ?? '')
  if (object === '*') return true
  if (object.endsWith('*')) return String(finding.object).startsWith(object.slice(0, -1))
  return object === String(finding.object)
}

/**
 * Split findings into kept and waived, and report expired waivers so the
 * report can say "this waiver expired, so the finding is back".
 */
export function applyWaivers(findings, document, now = Date.now()) {
  const active = []
  const expired = []
  for (const waiver of document.waivers ?? []) {
    if (isExpired(waiver, now)) expired.push(waiver)
    else active.push(waiver)
  }
  const kept = []
  const waived = []
  for (const finding of findings) {
    const match = active.find((waiver) => matchesWaiver(waiver, finding))
    if (match) waived.push({ ...finding, waiver: { reason: match.reason, expiresAt: match.expiresAt ?? null } })
    else kept.push(finding)
  }
  return { kept, waived, expired }
}
