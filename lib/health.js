/**
 * Environment health: what is running right now, what failed recently, and how
 * busy the org looks. Meant to answer "is it safe to publish?" before a release.
 */

import { D365Error } from './errors.js'
import { makeClient, readOrganization } from './runtime.js'

const FAILED_STATE = 3
const SUSPENDED_STATE = 0

async function count(client, path, filter, signal) {
  // `$count=true` is capped at 5000 by Dataverse; aggregation is exact.
  try {
    const url = client.buildUrl(path, { $filter: filter, $apply: 'aggregate($count as count)' })
    const page = await client.requestJson(url, { signal })
    const value = page?.value?.[0]?.count
    if (Number.isFinite(value)) return { count: value }
  } catch {
    // fall through to the simpler read
  }
  const url = client.buildUrl(path, { $filter: filter, $select: 'asyncoperationid', $top: 1, $count: 'true' })
  const page = await client.requestJson(url, { signal })
  return { count: page?.['@odata.count'] ?? page?.value?.length ?? 0, rows: page?.value ?? [] }
}

async function listFailed(client, sinceIso, signal) {
  const rows = []
  let next = client.buildUrl('asyncoperations', {
    $select: 'asyncoperationid,name,errorcode,message,modifiedon',
    $filter: `statecode eq ${FAILED_STATE} and modifiedon ge ${sinceIso}`,
    $orderby: 'modifiedon desc',
    $top: 50,
  })
  let pages = 0
  while (next && pages < 3) {
    const page = await client.requestJson(next, { signal })
    rows.push(...(page?.value ?? []))
    next = page?.['@odata.nextLink'] ?? null
    pages += 1
  }
  return rows
}

async function listRunningSolutions(client, signal) {
  const url = client.buildUrl('msdyn_solutionhistories', {
    $select: 'msdyn_name,msdyn_operation,msdyn_starttime,msdyn_endtime,msdyn_ismanaged',
    $filter: 'msdyn_endtime eq null',
    $orderby: 'msdyn_starttime desc',
    $top: 10,
  })
  const page = await client.requestJson(url, { signal })
  return page?.value ?? []
}

async function recentSolutions(client, signal) {
  const url = client.buildUrl('solutions', {
    $select: 'uniquename,friendlyname,version,ismanaged,installedon',
    $orderby: 'installedon desc',
    $top: 5,
  })
  const page = await client.requestJson(url, { signal })
  return page?.value ?? []
}

/** Collect one environment's health snapshot. */
export async function readHealth(config, envKey, options = {}) {
  const env = config.environments[envKey]
  if (!env) throw new D365Error(`未知环境：${envKey}`, { hint: `可用：${Object.keys(config.environments).join(', ')}` })
  const hours = Number.isFinite(options.hours) ? options.hours : 24
  const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString()
  const client = makeClient(env, config)
  const signal = options.signal

  const version = await client.readVersion().catch(() => null)
  const organization = await readOrganization(client, signal).catch(() => null)
  const suspended = await count(client, 'asyncoperations', `statecode eq ${SUSPENDED_STATE}`, signal).catch(() => ({ count: null }))
  const failed = await count(client, 'asyncoperations', `statecode eq ${FAILED_STATE} and modifiedon ge ${sinceIso}`, signal).catch(() => ({ count: null }))
  const failures = await listFailed(client, sinceIso, signal).catch(() => [])
  const failureGroups = new Map()
  for (const row of failures) {
    const name = String(row.name ?? '')
    const key = `${name}|${row.errorcode ?? ''}`
    const group = failureGroups.get(key) ?? {
      name,
      message: String(row.message ?? ''),
      errorcode: Number(row.errorcode ?? 0),
      count: 0,
      modifiedon: String(row.modifiedon ?? ''),
    }
    group.count += 1
    failureGroups.set(key, group)
  }
  const running = await listRunningSolutions(client, signal).catch(() => [])
  const recent = await recentSolutions(client, signal).catch(() => [])

  return {
    env: envKey,
    url: env.url ?? '',
    version: version ?? '',
    organization: organization?.name ?? '',
    suspended: suspended.count ?? 0,
    failed: failed.count ?? 0,
    hours,
    failures: [...failureGroups.values()].map((row) => ({
      name: row.name,
      message: row.message,
      operationtype: 0,
      modifiedon: row.modifiedon,
      count: row.count,
      errorcode: row.errorcode,
    })),
    runningSolutions: running.map((row) => ({
      name: String(row.msdyn_name ?? ''),
      operation: Number(row.msdyn_operation ?? 0),
      startedAt: String(row.msdyn_starttime ?? ''),
      managed: row.msdyn_ismanaged === true,
    })),
    recentSolutions: recent.map((row) => ({
      uniquename: String(row.uniquename ?? ''),
      version: String(row.version ?? ''),
      managed: row.ismanaged === true,
      installedon: String(row.installedon ?? ''),
    })),
  }
}

export function renderHealth(rows) {
  const lines = []
  lines.push('环境健康检查')
  lines.push('')
  lines.push('| 环境 | 版本 | 组织 | 挂起作业 | 近期失败 | 正在导入/发布 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const row of rows) {
    lines.push(`| ${row.env} | ${row.version ?? '—'} | ${row.organization ?? '—'} | ${row.suspended ?? '—'} | ${row.failed ?? '—'} | ${row.runningSolutions.length} |`)
  }
  lines.push('')
  for (const row of rows) {
    if (!row.runningSolutions.length && !row.failures.length) continue
    lines.push(`### ${row.env}`)
    if (row.runningSolutions.length) {
      lines.push(`- 正在运行：${row.runningSolutions.map((item) => `${item.name}（${item.operation}）`).join('、')}`)
    }
    for (const failure of row.failures.slice(0, 5)) {
      const times = failure.count > 1 ? ` ×${failure.count}` : ''
      const code = failure.errorcode ? `（code ${failure.errorcode}）` : ''
      // `message` is often empty on async operations; a trailing dash reads as a
      // rendering bug, so only add the separator when there is text to show.
      const detail = String(failure.message ?? '').trim()
      lines.push(`- 失败${times}：${failure.name}${code}${detail ? ` — ${detail.slice(0, 160)}` : ''}`)
    }
    lines.push('')
  }
  return [{ type: 'text', text: lines.join('\n') }]
}
