/**
 * Dataverse Web API client.
 *
 * Every request is a GET or write to one environment. Reads are split in two:
 * metadata and definition tables need the `metadata.read` capability, business
 * records need `data.read`. The check lives here, at the single choke point, so
 * a new tool cannot accidentally bypass it.
 */
import { getAccessToken, forgetToken } from './auth.js'
import { D365Error, describeDataverseError, httpErrorHint } from './errors.js'
import { errorCodeFromBody } from './error-codes.js'

const API_VERSION = 'v9.2'
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
/** Methods the server treats as read-only, so repeating them cannot write twice. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Entity sets and endpoints that only expose metadata or deployment state.
 * Anything not listed here is treated as business data.
 */
const METADATA_READ_PREFIXES = [
  'entitydefinitions',
  'relationshipdefinitions',
  'globaloptionsets',
  'globaloptionsetdefinitions',
  'solutions',
  'solutioncomponents',
  'publishers',
  'sdkmessageprocessingsteps',
  'sdkmessageprocessingstepimages',
  'sdkmessages',
  'pluginassemblies',
  'plugintypes',
  'webresourceset',
  'systemforms',
  'savedqueries',
  'workflows',
  'customapis',
  'sitemaps',
  'organizations',
  'msdyn_componentlayers',
  'msdyn_solutionhistories',
  'retrieveversion',
  '$metadata',
]

/**
 * Action endpoints that change metadata or deployment state rather than
 * business records. They are allowed through the `data.write` guard; the
 * metadata capabilities are enforced separately by `d365_write`.
 */
const METADATA_WRITE_SEGMENTS = [
  'publishxml',
  'publishallxml',
  'insertoptionvalue',
  'updateoptionvalue',
  'deleteoptionvalue',
  'createattribute',
  'updateattribute',
  'deleteattribute',
  'removeactivecustomizations',
  'updateentity',
  'createentity',
  'deleteentity',
  'addsolutioncomponent',
  'removesolutioncomponent',
]

let dataReadResolver = async () => false
let dataWriteResolver = async () => false
let metadataReadResolver = async () => true
let capabilityResolver = async () => false

/**
 * Install the generic `(environment, capability) => boolean` decision function.
 *
 * Only `d365_invoke` uses it, and only for the capability it names explicitly on
 * the request: everything else keeps the three narrow resolvers above, so this
 * does not widen any existing gate.
 */
export function setCapabilityResolver(resolver) {
  capabilityResolver = typeof resolver === 'function' ? resolver : async () => false
}

/** Install the `data.read` decision function; index.js points it at the policy file. */
export function setDataReadResolver(resolver) {
  dataReadResolver = typeof resolver === 'function' ? resolver : async () => false
}

/** Install the `data.write` decision function; index.js points it at the policy file. */
export function setDataWriteResolver(resolver) {
  dataWriteResolver = typeof resolver === 'function' ? resolver : async () => false
}

/** Install the `metadata.read` decision function; index.js points it at the policy file. */
export function setMetadataReadResolver(resolver) {
  metadataReadResolver = typeof resolver === 'function' ? resolver : async () => true
}

function urlSegment(url) {
  const text = String(url?.pathname ?? url ?? '')
  const marker = `/api/data/${API_VERSION}/`
  const at = text.indexOf(marker)
  const rest = at >= 0 ? text.slice(at + marker.length) : text.replace(/^\/+/, '')
  return rest.split(/[/?(]/)[0].toLowerCase()
}

/** @returns true when the URL only touches metadata or deployment state. */
export function isMetadataRead(url) {
  const segment = urlSegment(url)
  return METADATA_READ_PREFIXES.some((prefix) => segment === prefix || segment.startsWith(`${prefix}(`))
}

/** @returns true when the URL changes metadata or deployment state, not business records. */
export function isMetadataWrite(url) {
  const segment = urlSegment(url)
  if (isMetadataRead(url)) return true
  return METADATA_WRITE_SEGMENTS.some((name) => segment === name)
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run `fetch` with a timeout, while still honoring a caller-provided signal.
 *
 * The timer stays armed after the response headers arrive: a server that sends
 * headers and then stalls the body would otherwise hang forever, because
 * `response.text()` is not covered by the `fetch` promise. The caller must call
 * `release()` once the body has been consumed (or the request abandoned).
 * @returns `{ response, release }`.
 */
async function timedFetch(url, init, timeoutMs, externalSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs)
  let listener
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason)
    else {
      listener = () => controller.abort(externalSignal.reason)
      externalSignal.addEventListener('abort', listener, { once: true })
    }
  }
  const release = () => {
    clearTimeout(timer)
    if (listener) externalSignal.removeEventListener('abort', listener)
  }
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    return { response, release }
  } catch (error) {
    release()
    throw error
  }
}

/** Seconds to wait from a `Retry-After` header, falling back to exponential backoff. */
function retryDelay(response, attempt) {
  const header = response.headers.get('retry-after')
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 120) * 1000
  return Math.min(1000 * 2 ** attempt, 20_000)
}

export class DataverseClient {
  /**
   * @param env - normalized environment.
   * @param options - timeout, retry budget, and request counters shared by a tool call.
   */
  constructor(env, options = {}) {
    this.env = env
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.maxRetries = options.maxRetries ?? 4
    this.counters = options.counters ?? { requests: 0 }
  }

  get apiBase() {
    return `${this.env.url}/api/data/${API_VERSION}/`
  }

  /**
   * Build one absolute Web API URL.
   * @param path - path relative to the Web API root; may contain OData segments.
   * @param params - query options such as `$select`. Empty values are dropped.
   */
  buildUrl(path, params = {}) {
    const url = new URL(this.apiBase + path)
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
    return url
  }

  /**
   * GET one URL and decode it as JSON, retrying throttling and refreshing the
   * token once on 401.
   * @returns the parsed JSON value.
   */
  async requestJson(url, state = {}) {
    const attempt = state.attempt ?? 0
    const refreshed = state.refreshed ?? false
    const method = state.method ?? 'GET'

    if (method === 'GET') {
      // Metadata and business records are gated separately: an environment can
      // allow reading table definitions while business rows stay closed.
      const metadata = isMetadataRead(url)
      const allowed = metadata
        ? await metadataReadResolver(this.env.key)
        : await dataReadResolver(this.env.key)
      if (!allowed) {
        throw new D365Error(
          metadata
            ? `环境 ${this.env.key} 未授权读取元数据`
            : `环境 ${this.env.key} 未授权读取业务数据`,
          {
            code: metadata ? 'metadata-read-forbidden' : 'data-read-forbidden',
            hint: metadata
              ? `在设置页「D365 工具箱 → 权限」里给 ${this.env.key} 勾上「读取元数据」后再试。`
              : `在设置页「D365 工具箱 → 权限」里给 ${this.env.key} 勾上「读取业务数据」后再试。`,
          },
        )
      }
    }

    if (method !== 'GET' && !isMetadataWrite(url)) {
      // A caller may name a different capability for one request (only
      // `d365_invoke` does, after checking it itself). Everything else still
      // walks the `data.write` gate.
      const capability = state.capability === 'message.invoke' ? 'message.invoke' : 'data.write'
      const allowed = capability === 'message.invoke'
        ? await capabilityResolver(this.env.key, 'message.invoke')
        : await dataWriteResolver(this.env.key)
      if (!allowed) {
        throw new D365Error(
          capability === 'message.invoke'
            ? `环境 ${this.env.key} 未授权调用消息`
            : `环境 ${this.env.key} 未授权新增或修改业务数据`,
          {
            code: capability === 'message.invoke' ? 'message-invoke-forbidden' : 'data-write-forbidden',
            hint: capability === 'message.invoke'
              ? `在设置页「D365 工具箱 → 权限」里给 ${this.env.key} 勾上「调用消息」后再试。`
              : `在设置页「D365 工具箱 → 权限」里给 ${this.env.key} 勾上「新增/修改业务数据」后再试。元数据的修改走 d365_write，不受这个开关影响。`,
          },
        )
      }
    }

    const token = await getAccessToken(this.env, { force: refreshed })
    this.counters.requests += 1

    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'odata-maxversion': '4.0',
      'odata-version': '4.0',
    }
    if (state.body !== undefined) headers['content-type'] = 'application/json; charset=utf-8'
    if (state.headers) Object.assign(headers, state.headers)

    let response
    let release = () => {}
    try {
      const timed = await timedFetch(
        url,
        {
          method,
          headers,
          body: state.body === undefined ? undefined : JSON.stringify(state.body),
        },
        this.timeoutMs,
        state.signal,
      )
      response = timed.response
      release = timed.release
    } catch (error) {
      // A failed request is only safe to repeat when the server provably did
      // not act on it. A timeout or a dropped connection after the bytes went
      // out tells us nothing: retrying a POST/PATCH/DELETE there duplicates the
      // write (a second CreateAttribute, a second InsertOptionValue).
      if (attempt < this.maxRetries && SAFE_METHODS.has(method)) {
        await wait(500 * (attempt + 1))
        return this.requestJson(url, { ...state, attempt: attempt + 1 })
      }
      throw new D365Error(`请求环境 ${this.env.key} 失败：${error.message}`, {
        code: 'network',
        hint: SAFE_METHODS.has(method)
          ? '检查网络与该环境 URL 是否可达。'
          : '写入请求可能已在环境里生效，也可能没生效——先到环境里核对结果，再决定是否重试。',
      })
    }

    if (response.status === 401 && !refreshed) {
      release()
      forgetToken(this.env.key)
      return this.requestJson(url, { ...state, refreshed: true })
    }

    // 429 means the request was rejected before running, so repeating it is
    // safe for any method. 5xx is different: the server may have half-applied a
    // write, so only idempotent methods are retried.
    const retryable = response.status === 429
      || (RETRYABLE_STATUS.has(response.status) && SAFE_METHODS.has(method))
    if (retryable && attempt < this.maxRetries) {
      release()
      await wait(retryDelay(response, attempt))
      return this.requestJson(url, { ...state, attempt: attempt + 1 })
    }

    let text
    try {
      text = await response.text()
    } catch (error) {
      throw new D365Error(`读取环境 ${this.env.key} 的响应失败：${error.message}`, {
        code: 'network',
        hint: '响应头已经到了但正文没有在超时内读完；写入是否生效以环境里的实际状态为准。',
      })
    } finally {
      release()
    }
    if (!response.ok) {
      let body
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
      throw new D365Error(`环境 ${this.env.key} 返回 HTTP ${response.status}：${describeDataverseError(body)}`, {
        code: 'http',
        status: response.status,
        errorCode: errorCodeFromBody(body),
        // Keep the body: the message above is a summary, and when a write fails
        // on one property the original payload text is what a person needs.
        body: text.length > 8000 ? `${text.slice(0, 8000)}…（共 ${text.length} 字符）` : text,
        hint: httpErrorHint({ status: response.status, body }),
      })
    }

    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      throw new D365Error(`环境 ${this.env.key} 返回的不是 JSON`, { code: 'decode' })
    }
  }

  /**
   * GET a collection, following `@odata.nextLink` until `limit` rows are
   * collected. Returns the rows and whether more exist.
   *
   * `$top` is sent with the first request: without it the server picks its own
   * page size (thousands of rows), which on a real organization made one
   * `systemforms` page take ~28 seconds when three rows were all that was
   * wanted.
   * @param limit - hard cap on returned rows.
   */
  async getPaged(path, params, limit, signal) {
    const records = []
    const first = { ...params }
    const unlimited = !Number.isFinite(limit)
    // `__noTop` is the fallback path's opt-out: some endpoints (the metadata
    // ones) reject `$top` outright, and retrying must not re-add it.
    const noTop = first.__noTop === true || unlimited
    delete first.__noTop
    // Ask for one row more than the cap: a server that fills `$top` exactly
    // sends no `@odata.nextLink`, so without the probe row a capped response
    // is indistinguishable from a complete one.
    if (!noTop && first.$top === undefined && Number.isFinite(limit)) first.$top = limit + 1
    let next = this.buildUrl(path, first)
    let pages = 0
    const maxPages = unlimited ? 20_000 : 500

    while (next && (unlimited || records.length < limit) && pages < maxPages) {
      const page = await this.requestJson(next, { signal })
      const value = Array.isArray(page?.value) ? page.value : []
      records.push(...value)
      next = page?.['@odata.nextLink']
      pages += 1
    }

    const overflow = !unlimited && records.length > limit
    return {
      records: overflow ? records.slice(0, limit) : records,
      hasMore: Boolean(next) || overflow,
      pages,
    }
  }

  /** GET a single record (collection query with `$top=1`). */
  async getOne(path, params, signal) {
    const url = this.buildUrl(path, { ...params, $top: 1 })
    const page = await this.requestJson(url, { signal })
    return Array.isArray(page?.value) ? page.value[0] : page
  }

  /**
   * POST a JSON body (an unbound action such as `InsertOptionValue`) and decode
   * the response. Writes are reachable only through the audited write pipeline.
   */
  async postJson(path, body, signal) {
    return this.requestJson(this.buildUrl(path), { method: 'POST', body, signal })
  }

  /**
   * Send one JSON body with any method and extra headers.
   *
   * Metadata creation and update need more than POST: creating a column is a
   * POST to the entity's `Attributes` collection, updating it is a PUT that
   * carries `MSCRM.MergeLabels`, and deleting it is a DELETE. None of those are
   * actions, so the option-value helpers do not cover them.
   * @param path - Web API path.
   * @param options - `{ method, body, headers }`.
   */
  async sendJson(path, options = {}, signal) {
    const { method = 'POST', body, headers } = options
    return this.requestJson(this.buildUrl(path), { method, body, headers, signal })
  }

  /**
   * Read the organization's platform version.
   *
   * The `organization` table does not expose a `version` property in every
   * deployment (a real one rejected `$select=version` with 0x80060888), so the
   * supported `RetrieveVersion` action is the only portable source. It is
   * best-effort: a missing version must not fail a connection check.
   */
  async readVersion(signal) {
    try {
      const payload = await this.requestJson(this.buildUrl('RetrieveVersion'), { signal })
      return payload?.Version ?? payload?.version ?? undefined
    } catch {
      return undefined
    }
  }
}

/**
 * GET with progressive fallbacks for query options real deployments reject.
 *
 * Dataverse does not accept the same `$select`/`$orderby` vocabulary on every
 * endpoint or version: a metadata endpoint answers `$orderby` with
 * 0x80060888 "The query parameter ... is not supported", and a table may lack a
 * property this plugin asked for ("Could not find a property named 'modifiedon'
 * on type 'Microsoft.Dynamics.CRM.systemform'"). Each rejection narrows the
 * request — one field at a time — instead of failing the whole resource.
 * @returns `{ page, selectDropped, orderbyDropped, droppedFields }`.
 */
export async function getPagedWithSelectFallback(client, path, params, limit, signal) {
  const dropped = { selectDropped: false, orderbyDropped: false, topDropped: false, droppedFields: [] }
  const current = { ...params }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return { page: await client.getPaged(path, current, limit, signal), ...dropped }
    } catch (error) {
      if (error?.status !== 400) throw error
      const text = String(error.message ?? '')

      const missing = /property named '([^']+)'/.exec(text)
      if (missing && current.$select) {
        const fields = current.$select.split(',').map((item) => item.trim()).filter(Boolean)
        const kept = fields.filter((field) => field.toLowerCase() !== missing[1].toLowerCase())
        if (kept.length && kept.length < fields.length) {
          current.$select = kept.join(',')
          dropped.droppedFields.push(missing[1])
          continue
        }
      }

      // "The query parameter '...' is not supported": the name is often
      // redacted before it reaches us, so narrow the request by dropping the
      // options in turn, cheapest first. `$top` is added inside getPaged, so
      // the check is on the marker, not on the params object.
      if (/query parameter/i.test(text) && !dropped.topDropped) {
        current.__noTop = true
        delete current.$top
        dropped.topDropped = true
        continue
      }
      if (current.$orderby) {
        delete current.$orderby
        dropped.orderbyDropped = true
        continue
      }
      if (current.$select) {
        delete current.$select
        dropped.selectDropped = true
        continue
      }
      throw error
    }
  }

  return { page: await client.getPaged(path, current, limit, signal), ...dropped }
}
