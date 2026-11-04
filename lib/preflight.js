/**
 * Is the target environment in the middle of a solution import or publish?
 *
 * Microsoft ships first-party updates as solution imports, and while one is
 * running Dataverse holds the customization lock: our metadata writes either
 * fail with 0x80071151 ("another operation is in progress") or hang until the
 * HTTP client gives up. `msdyn_solutionhistories` records every import,
 * uninstall, export and publish with a start time; a row whose `msdyn_endtime`
 * is still null means that operation has not finished.
 */
import { D365Error } from './errors.js'

/** Operations older than this are treated as zombie rows, not as active work. */
export const DEFAULT_BUSY_WINDOW_MINUTES = 120

const OPERATION_LABELS = {
  0: '导入',
  1: '卸载',
  2: '导出',
  3: '发布',
  7: '元数据生成',
}

const SELECT_FIELDS = 'msdyn_name,msdyn_starttime,msdyn_operation,msdyn_ismanaged,msdyn_publishername'

export function describeBlocker(blocker) {
  const parts = [blocker.name]
  parts.push(blocker.operation)
  if (blocker.ageMinutes !== null) parts.push(`${blocker.ageMinutes} 分钟前开始`)
  if (blocker.publisher) parts.push(`发行者 ${blocker.publisher}`)
  return `${parts[0]}（${parts.slice(1).join('，')}）`
}

/**
 * @returns {Promise<{
 *   available: boolean, checkedAt: string, windowMinutes: number, reason?: string,
 *   blockers: object[], active: object[], stale: object[], busy: boolean,
 * }>}
 */
export async function checkEnvironmentIdle(client, { windowMinutes = DEFAULT_BUSY_WINDOW_MINUTES, signal } = {}) {
  const checkedAt = new Date().toISOString()
  const url = client.buildUrl('msdyn_solutionhistories', {
    $select: SELECT_FIELDS,
    $filter: 'msdyn_endtime eq null',
    $orderby: 'msdyn_starttime desc',
    $top: 25,
  })

  let rows
  try {
    const page = await client.requestJson(url, { signal })
    rows = Array.isArray(page?.value) ? page.value : []
  } catch (error) {
    // No privilege on the table, or the environment does not expose it: the
    // check is a safety net, not a gate we can enforce without data.
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
      checkedAt,
      windowMinutes,
      blockers: [],
      active: [],
      stale: [],
      busy: false,
    }
  }

  const now = Date.now()
  const blockers = rows.map((row) => {
    const startedAt = row.msdyn_starttime ?? null
    const started = startedAt ? Date.parse(startedAt) : Number.NaN
    return {
      name: row.msdyn_name ?? '(未命名)',
      operation: OPERATION_LABELS[row.msdyn_operation] ?? `操作 ${row.msdyn_operation}`,
      managed: row.msdyn_ismanaged === true,
      publisher: row.msdyn_publishername ?? '',
      startedAt,
      ageMinutes: Number.isFinite(started) ? Math.max(0, Math.round((now - started) / 60000)) : null,
    }
  })

  const active = blockers.filter((blocker) => blocker.ageMinutes !== null && blocker.ageMinutes <= windowMinutes)
  const stale = blockers.filter((blocker) => !active.includes(blocker))

  return {
    available: true,
    checkedAt,
    windowMinutes,
    blockers,
    active,
    stale,
    busy: active.length > 0,
  }
}

export function busyError(envKey, state) {
  // One solution import shows up as many rows (per patch step), and a publish
  // shows up repeatedly: collapse to one line per name, newest first.
  const seen = new Map()
  for (const blocker of state.active) {
    const previous = seen.get(blocker.name)
    if (!previous || (blocker.ageMinutes ?? Infinity) < (previous.ageMinutes ?? Infinity)) {
      seen.set(blocker.name, blocker)
    }
  }
  const collapsed = [...seen.values()].sort((a, b) => (a.ageMinutes ?? 0) - (b.ageMinutes ?? 0))
  const shown = collapsed.slice(0, 4).map(describeBlocker).join('；')
  const more = collapsed.length > 4 ? `；等 ${collapsed.length} 个操作` : ''
  const staleNote = state.stale.length
    ? ` 另有 ${state.stale.length} 条超过 ${state.windowMinutes} 分钟仍未结束的旧记录，可能是残留。`
    : ''
  return new D365Error(`环境 ${envKey} 正在导入或发布解决方案，此时写入会失败或长时间卡住`, {
    code: 'environment-busy',
    hint: `进行中：${shown}${more}。${staleNote} 等它结束后重试；确认要跳过检查可以传 force: true。`,
  })
}
