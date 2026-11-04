/**
 * Contract drift history: one compact entry per run, so a report can say
 * "these 12 are new since yesterday" instead of repeating the same 84 lines.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dataRoot } from './snapshot.js'

const LIMIT = 60

export function historyPath(config) {
  return join(dataRoot(config), 'reports', 'contract-history.json')
}

export function findingKey(finding) {
  return `${finding.rule}|${finding.env}|${finding.object}`
}

export async function readHistory(config) {
  try {
    const text = await readFile(historyPath(config), 'utf8')
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
    return Array.isArray(parsed?.runs) ? parsed : { runs: [] }
  } catch (error) {
    if (error?.code === 'ENOENT') return { runs: [] }
    throw error
  }
}

export async function appendHistory(config, entry) {
  const document = await readHistory(config)
  document.runs.push(entry)
  if (document.runs.length > LIMIT) document.runs = document.runs.slice(-LIMIT)
  const path = historyPath(config)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(document, null, 2), 'utf8')
  return document.runs
}

/** Compare this run against the previous one for the same source/targets. */
export function compareWithPrevious(previous, currentKeys) {
  if (!previous) return null
  const before = new Set(previous.keys ?? [])
  const now = new Set(currentKeys)
  const added = [...now].filter((key) => !before.has(key))
  const fixed = [...before].filter((key) => !now.has(key))
  return { comparedTo: previous.at, added, fixed }
}
