/**
 * Shared plumbing for the metadata tools: environment selection, workspace
 * artifact writing, and the plain-text formatting used in tool results.
 *
 * Every tool result is "summary + path": the model gets a short, readable
 * digest, and the complete data lands in a file it can read in full when the
 * question needs it. That keeps results small without losing evidence.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { DataverseClient } from './client.js'
import { D365Error } from './errors.js'
import { credentialStatus, dataDirectory } from './config.js'
import { KEY_FIELDS, COMPARE_FIELDS, rowKey } from './resources.js'

/** Rows kept in the inline digest before the rest is left to the artifact. */
export const INLINE_ROWS = 12

/**
 * Pick and validate the environments a call targets.
 * @param config - normalized config.
 * @param args - tool arguments (`environment`, `environments`, `allEnvironments`).
 * @returns the ordered list of environments to query.
 */
export function pickEnvironments(config, args = {}) {
  const available = config.environments
  const keys = Object.keys(available)
  if (!keys.length) {
    throw new D365Error('还没有配置任何 D365 环境', {
      code: 'no-environments',
      hint: '在插件配置的 environments 下加入环境（url + 凭据环境变量名），见 cordis.patch.yml 的注释示例。',
    })
  }

  if (args.allEnvironments) return keys.map((key) => available[key])

  const requested = []
  if (Array.isArray(args.environments)) requested.push(...args.environments)
  if (args.environment) requested.push(args.environment)

  const unique = [...new Set(requested.filter((key) => typeof key === 'string' && key.trim()))]
  if (!unique.length) {
    const fallback = config.defaultEnvironment
    if (!fallback) throw new D365Error('未指定环境，且没有默认环境', { code: 'no-default' })
    return [available[fallback]]
  }

  const missing = unique.filter((key) => !available[key])
  if (missing.length) {
    throw new D365Error(`未知环境：${missing.join(', ')}`, {
      code: 'unknown-environment',
      hint: `可用环境：${keys.join(', ')}`,
    })
  }
  return unique.map((key) => available[key])
}

/**
 * Create a client for one environment.
 * @param env - normalized environment.
 * @param config - normalized config (for timeout).
 * @returns a read-only client.
 */
export function makeClient(env, config) {
  return new DataverseClient(env, { timeoutMs: config.timeoutMs })
}

/**
 * Read the organization record plus the platform version.
 *
 * No `$select`: real deployments reject columns this plugin assumed were
 * universal (`version`, then `organizationstructure` — both 0x80060888 "Could
 * not find a property named ..."), and an unfiltered row is the only shape that
 * works everywhere. The record is optional — the version endpoint alone proves
 * the connection — so a rejected organization read is not fatal on its own.
 * @returns `{ ...organizationProperties, version? }`
 */
export async function readOrganization(client, signal) {
  let record = {}
  let failure
  try {
    const page = await client.getPaged('organizations', {}, 1, signal)
    record = page.records[0] ?? {}
  } catch (error) {
    failure = error
  }

  const version = await client.readVersion(signal)
  if (!Object.keys(record).length && !version && failure) throw failure
  return { ...record, version }
}

/**
 * Report environments and whether they can authenticate, without calling the
 * network unless `check` is set.
 * @returns a printable status report.
 */
export async function environmentStatus(config, options = {}) {
  const report = []
  for (const env of Object.values(config.environments)) {
    const status = credentialStatus(env)
    const row = {
      env,
      ...status,
      reachable: undefined,
      error: undefined,
    }
    if (options.check) {
      try {
        const client = makeClient(env, config)
        row.organization = await readOrganization(client, options.signal)
        row.reachable = true
      } catch (error) {
        row.reachable = false
        row.error = error.message
      }
    }
    report.push(row)
  }
  return report
}

/** Resolve the directory artifacts are written to. */
export function artifactRoot(config) {
  return join(dataDirectory(config), '.d365', 'query')
}

/**
 * Write one artifact and return its workspace-relative path.
 * @param name - filename without extension.
 * @param payload - JSON-serialisable data.
 */
export async function writeArtifact(config, name, payload) {
  const root = artifactRoot(config)
  await mkdir(root, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(root, `${stamp}-${name.replace(/[^a-zA-Z0-9._-]+/g, '-')}.json`)
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return relative(process.cwd(), file).replace(/\\/g, '/')
}

/** Truncate a cell so one wide field cannot blow up the digest. */
function cell(value, width = 40) {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return text.length > width ? `${text.slice(0, width - 1)}…` : text
}

/**
 * Render rows as a fixed-width markdown table; omitted columns are counted.
 * @param rows - records already flattened.
 * @param columns - column names in display order.
 */
export function formatTable(rows, columns, options = {}) {
  const width = options.width ?? 40
  const limit = options.limit ?? INLINE_ROWS
  const shown = rows.slice(0, limit)
  const header = `| ${columns.map((c) => cell(c, 24)).join(' | ')} |`
  const divider = `| ${columns.map(() => '---').join(' | ')} |`
  const body = shown.map((row) => `| ${columns.map((c) => cell(row?.[c], width)).join(' | ')} |`)
  const lines = [header, divider, ...body]
  if (rows.length > shown.length) lines.push(`| … 其余 ${rows.length - shown.length} 行见文件 |`)
  return lines.join('\n')
}

/**
 * Compare rows from several environments and describe what differs.
 * Presence is always compared; a few resources also compare meaningful fields.
 * @param resource - resource key, for key/compare field lookup.
 * @param perEnv - array of `{ env, rows }`.
 * @returns `{ lines, missing, extra, changed }` where `lines` is printable text.
 */
export function compareEnvironments(resource, perEnv) {
  if (perEnv.length < 2) return null

  const keysByEnv = new Map()
  const rowsByEnv = new Map()
  for (const { env, rows } of perEnv) {
    const map = new Map()
    for (const row of rows) map.set(rowKey(resource, row), row)
    keysByEnv.set(env.key, map)
    rowsByEnv.set(env.key, rows)
  }

  const envKeys = perEnv.map((entry) => entry.env.key)
  const allKeys = [...new Set(perEnv.flatMap((entry) => [...keysByEnv.get(entry.env.key).keys()]))]

  const onlyIn = new Map()
  const changed = []
  const compareFields = COMPARE_FIELDS[resource] ?? []

  for (const key of allKeys) {
    const present = envKeys.filter((envKey) => keysByEnv.get(envKey).has(key))
    if (present.length !== envKeys.length) {
      const missingIn = envKeys.filter((envKey) => !present.includes(envKey))
      const label = `${key} 仅存在于 ${present.join('/')}，缺失于 ${missingIn.join('/')}`
      onlyIn.set(key, { present, missingIn, label })
    }
    if (compareFields.length && present.length > 1) {
      const diffs = []
      for (const field of compareFields) {
        const values = present.map((envKey) => String(keysByEnv.get(envKey).get(key)?.[field] ?? ''))
        if (new Set(values).size > 1) {
          diffs.push(`${field}: ${present.map((envKey, i) => `${envKey}=${values[i] || '∅'}`).join(' / ')}`)
        }
      }
      if (diffs.length) changed.push(`${key} — ${diffs.join('；')}`)
    }
  }

  const lines = []
  if (!onlyIn.size && !changed.length) {
    lines.push(`跨环境对比（${envKeys.join(' / ')}）：按 ${KEY_FIELDS[resource] ?? '名称'} 对齐后无差异。`)
  } else {
    if (onlyIn.size) {
      lines.push(`跨环境差异：${onlyIn.size} 个对象的环境分布不一致`)
      for (const entry of [...onlyIn.values()].slice(0, 15)) lines.push(`- ${entry.label}`)
      if (onlyIn.size > 15) lines.push(`- … 其余 ${onlyIn.size - 15} 条见文件`)
    }
    if (changed.length) {
      lines.push(`字段值差异：${changed.length} 个对象`)
      for (const line of changed.slice(0, 15)) lines.push(`- ${line}`)
      if (changed.length > 15) lines.push(`- … 其余 ${changed.length - 15} 条见文件`)
    }
  }
  return { lines, onlyIn, changed, allKeys }
}
