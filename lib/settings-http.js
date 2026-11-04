/**
 * HTTP surface for the settings page.
 *
 * The page is plain browser JavaScript, so it reaches the Host over the
 * authenticated `/api` Fetch channel that `ctx.connection.fetch` mounts, rather
 * than a raw route on the bare web server: the channel runs the same Host,
 * Origin and browser-credential checks every other `/api` call gets, so the
 * form cannot become an unauthenticated write path.
 *
 * The write routes add one more guard: the page must send an explicit
 * `x-d365-meta-write` header (and, when an `Origin` survives the channel, match
 * this server's origin). Browser pages cannot send a custom header across
 * origins without a CORS preflight the routes never answer, so "a person
 * confirmed this in the settings page" stays true for metadata changes.
 *
 * Every handler funnels into the same modules the tools use, so the UI and the
 * agent cannot disagree about what was saved.
 */
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readSettings, saveGeneral, saveGitlab, saveSettings, checkEnvironment } from './settings-store.js'
import { dataDirectory, loadConfig } from './config.js'
import { checkGitlab } from './gitlab.js'
import { D365Error } from './errors.js'
import { CAPABILITIES, allows, readPolicy, savePolicy } from './write-policy.js'
import { deletePlan, listChanges, listPlans, listPublishReports, readPlan, writePublishReport } from './write-store.js'
import { executePlan, publishNow, publishTargets } from './write-actions.js'
import { applyCleanup, compactAllSnapshots, formatBytes, planCleanup, storageSummary } from './retention.js'

const BASE = '/api/d365-meta'

/** Header the settings page sends on every route that can change an environment. */
const WRITE_HEADER = 'x-d365-meta-write'
const WRITE_HEADER_VALUE = '1'

/** JSON response helper. */
function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Map a thrown error to the response the page can show. */
function failure(error) {
  if (error instanceof D365Error) return json(400, { error: error.message, hint: error.hint })
  return json(500, { error: error?.message ?? String(error) })
}

/**
 * Register the settings and write routes.
 * @param ctx - `{ connection, origin }`; `origin` is the web server's own origin.
 * @param state - holds the raw patch config.
 * @returns disposer.
 */
export function registerRoutes(ctx, state) {
  const fetch = ctx.connection.fetch
  const serverOrigin = ctx.origin
  const disposers = []

  /**
   * Is this `Origin` the page's own origin?
   *
   * Comparing against `webServer.getOrigin()` alone is fragile: that call throws
   * before the listener binds and its spelling (bind host vs request host) can
   * differ from what the browser sends. A browser request carries other
   * trustworthy hints for the same fact — the request URL and the `Host`
   * header — so any of them matching counts as same-origin. A non-browser client
   * sends no `Origin` at all, which is the property the guard actually needs.
   */
  function isSameOrigin(origin, request) {
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      return false
    }

    const candidates = []
    if (serverOrigin) candidates.push(serverOrigin)
    if (request.url) candidates.push(request.url)
    const host = request.headers.get('host')
    if (host) candidates.push(`${parsed.protocol}//${host}`)

    return candidates.some((candidate) => {
      try {
        return new URL(candidate).origin === parsed.origin
      } catch {
        return false
      }
    })
  }

  /** Record a rejection, so a wrong guard is diagnosable instead of silent. */
  function logRejection(reason, request) {
    try {
      const line = `${JSON.stringify({
        at: new Date().toISOString(),
        reason,
        origin: request.headers.get('origin'),
        host: request.headers.get('host'),
        url: request.url,
        serverOrigin,
        headers: [...request.headers.keys()].sort().join(','),
      })}\n`
      appendFile(join(dataDirectory(state.rawConfig), '.d365', 'write-guard.log'), line).catch(() => {})
    } catch {
      // Diagnostics are best-effort.
    }
  }

  /**
   * Browser-only guard for anything that changes an environment.
   *
   * Requiring `Origin` alone does not work: the authenticated `/api` channel
   * rewrites the request URL to `http://dsh.internal` and strips `Origin`, so
   * every real browser call arrived without one (see `.d365/write-guard.log`).
   * The page therefore proves itself with an explicit `x-d365-meta-write` header.
   * A cross-site page cannot send that header without a CORS preflight, and these
   * routes never answer a preflight, so the confirmation still cannot be forged
   * from another origin. An `Origin`, when the channel does pass one through,
   * must additionally be same-origin.
   */
  function requiresBrowserRequest(request) {
    const origin = request.headers.get('origin')
    if (origin && !isSameOrigin(origin, request)) {
      logRejection('origin-mismatch', request)
      return json(403, {
        error: '写入只能从设置页发起',
        hint: '请求来自其他站点；请在设置页确认计划。',
      })
    }
    if (request.headers.get(WRITE_HEADER) === WRITE_HEADER_VALUE) return undefined
    logRejection('missing-write-header', request)
    return json(403, {
      error: '写入只能从设置页发起',
      hint: '设置页会带上专用的确认头；命令行与工具无法伪造这次确认。',
    })
  }

  disposers.push(fetch.register({
    path: `${BASE}/config`,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        if (request.method === 'GET') {
          return json(200, { settings: await readSettings(state.rawConfig) })
        }
        const body = await request.json().catch(() => {
          throw new D365Error('请求体不是合法 JSON', { code: 'bad-json' })
        })
        const result = await saveSettings(state.rawConfig, body)
        return json(200, { settings: result.settings, secretsTouched: result.secretsTouched })
      } catch (error) {
        return failure(error)
      }
    },
  }))

  disposers.push(fetch.register({
    path: `${BASE}/settings`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const guard = requiresBrowserRequest(request)
        if (guard) return guard
        const body = await request.json().catch(() => ({}))
        // Two independent forms share this route so the page can save one
        // section without resending the other.
        if (body?.gitlab) {
          const settings = await saveGitlab(state.rawConfig, body.gitlab)
          return json(200, { settings })
        }
        const settings = await saveGeneral(state.rawConfig, body?.general ?? body ?? {})
        return json(200, { settings })
      } catch (error) {
        return failure(error)
      }
    },
  }))

  disposers.push(fetch.register({
    path: `${BASE}/gitlab/check`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const guard = requiresBrowserRequest(request)
        if (guard) return guard
        const body = await request.json().catch(() => null)
        const config = await loadConfig(state.rawConfig)
        // Let the form test values before they are saved.
        const candidate = body
          ? { ...config, gitlab: { ...config.gitlab, ...(body.url ? { url: String(body.url).replace(/\/+$/, '') } : {}) } }
          : config
        return json(200, await checkGitlab(candidate))
      } catch (error) {
        return failure(error)
      }
    },
  }))

  disposers.push(fetch.register({
    path: `${BASE}/storage`,
    methods: ['GET'],
    // Every exact route must declare a body mode. Without it the channel falls
    // back to streaming and constructs a GET request with a body, which throws
    // and surfaces as a bare HTTP 400 in the page.
    requestBody: 'buffered',
    async fetch() {
      try {
        const config = await loadConfig(state.rawConfig)
        return json(200, { storage: await storageSummary(config) })
      } catch (error) {
        return failure(error)
      }
    },
  }))

  disposers.push(fetch.register({
    path: `${BASE}/storage/cleanup`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const guard = requiresBrowserRequest(request)
        if (guard) return guard
        const body = await request.json().catch(() => ({}))
        const config = await loadConfig(state.rawConfig)
        const target = ['snapshots', 'reports', 'diffs', 'query', 'changes', 'all'].includes(body?.target)
          ? body.target
          : 'all'
        const plan = await planCleanup(config, { target })
        if (body?.dryRun !== false) {
          return json(200, {
            dryRun: true,
            plan: {
              target,
              totalFiles: plan.totalFiles,
              totalBytes: plan.totalBytes,
              totalText: formatBytes(plan.totalBytes),
              classes: plan.classes.map((row) => ({
                id: row.id,
                label: row.label,
                count: row.count,
                files: row.remove.length,
                bytes: row.bytes,
                bytesText: formatBytes(row.bytes),
                keep: row.keep,
                maxAgeDays: row.maxAgeDays,
              })),
            },
            storage: await storageSummary(config),
          })
        }
        const applied = await applyCleanup(config, plan)
        return json(200, {
          dryRun: false,
          deleted: applied.deleted.length,
          bytes: applied.bytes,
          bytesText: formatBytes(applied.bytes),
          failures: applied.failures,
          storage: await storageSummary(config),
        })
      } catch (error) {
        return failure(error)
      }
    },
  }))

  disposers.push(fetch.register({
    path: `${BASE}/storage/compact`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const guard = requiresBrowserRequest(request)
        if (guard) return guard
        const config = await loadConfig(state.rawConfig)
        const result = await compactAllSnapshots(config)
        return json(200, {
          snapshots: result.snapshots,
          files: result.files,
          savedBytes: result.savedBytes,
          savedText: formatBytes(result.savedBytes),
          storage: await storageSummary(config),
        })
      } catch (error) {
        return failure(error)
      }
    },
  }))

  disposers.push(fetch.register({
    path: `${BASE}/check`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const body = await request.json().catch(() => ({}))
        const key = String(body?.key ?? '').trim()
        if (!key) return json(400, { error: '缺少环境 key' })
        return json(200, await checkEnvironment(state.rawConfig, key))
      } catch (error) {
        return failure(error)
      }
    },
  }))

  disposers.push(fetch.register({
    path: `${BASE}/write/policy`,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const config = await loadConfig(state.rawConfig)
        if (request.method === 'GET') {
          const policy = await readPolicy(config.configFile)
          return json(200, {
            policy,
            capabilities: CAPABILITIES,
            environments: Object.keys(config.environments),
          })
        }
        const guard = requiresBrowserRequest(request)
        if (guard) return guard
        const body = await request.json().catch(() => ({}))
        const policy = await savePolicy(config.configFile, body ?? {})
        return json(200, { policy, capabilities: CAPABILITIES, environments: Object.keys(config.environments) })
      } catch (error) {
        return failure(error)
      }
    },
  }))

  disposers.push(fetch.register({
    path: `${BASE}/write/plans`,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch() {
      try {
        const config = await loadConfig(state.rawConfig)
        return json(200, {
          plans: await listPlans(config),
          changes: await listChanges(config, 10),
          publishes: await listPublishReports(config),
        })
      } catch (error) {
        return failure(error)
      }
    },
  }))

  disposers.push(fetch.register({
    path: `${BASE}/write/execute`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const guard = requiresBrowserRequest(request)
        if (guard) return guard
        const body = await request.json().catch(() => ({}))
        const planId = String(body?.planId ?? '').trim()
        if (!planId) return json(400, { error: '缺少 planId' })

        const config = await loadConfig(state.rawConfig)
        const plans = await listPlans(config)
        const plan = plans.find((item) => item.id === planId)
        if (!plan) {
          // Executing deletes the plan, so "not found" usually means "already
          // done, look at the page that ran it". The ledger is the only evidence
          // left; consult it before claiming the plan was cancelled.
          const done = (await listChanges(config, 50)).find((entry) => entry.planId === planId)
          if (done) {
            const ok = done.applied?.length ?? 0
            const failed = done.failed?.length ?? 0
            return json(409, {
              error: `该计划已经执行过：成功 ${ok} 个，失败 ${failed} 个`,
              executed: true,
              ok,
              failed,
              publishState: done.publishState,
            })
          }
          return json(404, { error: '计划不存在或已被取消' })
        }
        if (plan.status !== 'pending') {
          const label = plan.status === 'running'
            ? '正在执行，或上次执行中途中断'
            : plan.status === 'failed' ? '上次执行失败' : '已经执行过'
          return json(409, {
            error: `计划${label}`,
            hint: '先核对 .d365/changes 里的执行记录；要再做一次，请取消该计划并重新生成。',
            status: plan.status,
          })
        }

        const result = await executePlan(config, plan, undefined, { force: body?.force === true })
        await deletePlan(config, planId)
        return json(200, result)
      } catch (error) {
        return failure(error)
      }
    },
  }))

  disposers.push(fetch.register({
    path: `${BASE}/write/publish`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const guard = requiresBrowserRequest(request)
        if (guard) return guard
        const body = await request.json().catch(() => ({}))
        const planId = String(body?.planId ?? '').trim()
        if (!planId) return json(400, { error: '缺少 planId' })

        const config = await loadConfig(state.rawConfig)
        const entry = (await listChanges(config, 100)).find((item) => item.planId === planId)
        if (!entry) return json(404, { error: '没有找到这个计划的执行记录' })
        if (!(entry.applied?.length > 0)) return json(400, { error: '这个计划没有成功的写入，不需要发布' })

        // Publishing the result of a write is still part of that write: if the
        // permission was revoked after the plan ran, the person must not be able
        // to push the change live from the page.
        const policyPath = config.configFile
        const policy = policyPath ? await readPolicy(policyPath) : { environments: {} }
        if (entry.capability && !allows(policy, entry.envKey, entry.capability)) {
          return json(403, {
            error: `环境 ${entry.envKey} 未授权 ${entry.capability}，不能发布这次改动`,
            hint: '先到「权限」里重新授权，或在环境里手工发布。',
          })
        }

        const scope = publishTargets(entry.applied)
        const startedAt = new Date().toISOString()
        const outcome = await publishNow(config, entry.envKey, scope, { force: body?.force === true })
        const publish = {
          planId,
          envKey: entry.envKey,
          startedAt,
          finishedAt: new Date().toISOString(),
          targets: scope,
          republished: true,
          ok: outcome.ok,
          mode: outcome.mode,
          ...(outcome.error ? { error: outcome.error } : {}),
        }
        await writePublishReport(config, planId, publish)
        return json(200, { publish })
      } catch (error) {
        return failure(error)
      }
    },
  }))

  disposers.push(fetch.register({
    path: `${BASE}/write/cancel`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const guard = requiresBrowserRequest(request)
        if (guard) return guard
        const body = await request.json().catch(() => ({}))
        const planId = String(body?.planId ?? '').trim()
        if (!planId) return json(400, { error: '缺少 planId' })
        const config = await loadConfig(state.rawConfig)
        const plan = await readPlan(config, planId)
        if (!plan) return json(404, { error: '计划不存在或已被取消' })
        // Cancelling a running plan would hide writes that are still landing: the
        // execution loop has already read the operations it is applying.
        if (plan.status && plan.status !== 'pending') {
          const label = plan.status === 'running'
            ? '正在执行，或上次执行中途中断'
            : plan.status === 'failed' ? '上次执行失败' : '已经执行过'
          return json(409, {
            error: `计划${label}，不能取消`,
            hint: '先到 .d365/changes 核对执行记录。',
            status: plan.status,
          })
        }
        const removed = await deletePlan(config, planId)
        return json(200, { removed })
      } catch (error) {
        return failure(error)
      }
    },
  }))

  return () => {
    for (const dispose of disposers) Promise.resolve(dispose()).catch(() => {})
  }
}
