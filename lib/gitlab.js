/**
 * Read-only GitLab access for the diff-driven code check.
 *
 * Only one thing is needed: the list of files a merge request touches, with
 * their unified diffs. Everything else (mapping paths to Dataverse components,
 * comparing against an environment) lives in `code-check.js`.
 *
 * The token comes from `D365_GITLAB_TOKEN` / `GITLAB_TOKEN`, else from the
 * secrets file the settings page writes. It never travels to the browser.
 */
import { readGitlabToken } from './config.js'
import { D365Error } from './errors.js'
import { t } from './i18n.js'

const TIMEOUT_MS = 30_000

/**
 * Parse a GitLab merge-request URL.
 * @param value - e.g. `https://gitlab.example.com/g/p/-/merge_requests/42/diffs`
 * @returns `{ base, project, iid }` or null when the string is not a MR URL.
 */
export function parseMergeRequestUrl(value) {
  const text = String(value ?? '').trim()
  const match = text.match(/^(https?:\/\/[^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/i)
  if (!match) return null
  return { base: match[1], project: match[2], iid: match[3] }
}

/** `https://host` → `https://host/api/v4`, tolerating a trailing slash. */
export function apiBase(url) {
  return `${String(url ?? '').trim().replace(/\/+$/, '')}/api/v4`
}

function describeHttp(status, body) {
  const message = String(body ?? '').slice(0, 300).replace(/\s+/g, ' ')
  if (status === 401) return t('gitlab.http401')
  if (status === 403) return t('gitlab.http403')
  if (status === 404) return t('gitlab.http404')
  return t('gitlab.httpOther',{status,message})
}

/**
 * Call one GitLab API path and parse JSON.
 * @param config - loaded plugin config (supplies `gitlab.url` and the secrets path).
 * @param path - path beginning with `/`, e.g. `/projects/g%2Fp`.
 * @param signal - optional abort signal.
 * @param options - `{ base }`: the host to call instead of the configured one, so
 *   an MR link from a self-hosted instance is fetched from that instance.
 */
export async function gitlabGet(config, path, signal, options = {}) {
  // The MR URL wins over the configured host: a link that points at another
  // instance must be read from that instance, not from the default one.
  const url = String(options.base ?? config.gitlab?.url ?? '').trim()
  const token = await readGitlabToken(config)
  if (!url) {
    throw new D365Error(t('gitlab.noUrl'), {
      code: 'gitlab-not-configured',
      hint: t('gitlab.noUrlHint'),
    })
  }
  if (!token.ok) {
    throw new D365Error(t('gitlab.noToken'), {
      code: 'gitlab-no-token',
      hint: t('gitlab.noTokenHint'),
    })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal?.addEventListener?.('abort', onAbort, { once: true })
  try {
    const response = await fetch(`${apiBase(url)}${path}`, {
      headers: { 'PRIVATE-TOKEN': token.value, accept: 'application/json' },
      signal: controller.signal,
    })
    const body = await response.text()
    if (!response.ok) {
      throw new D365Error(describeHttp(response.status, body), { code: 'gitlab-http' })
    }
    return body ? JSON.parse(body) : null
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new D365Error(t('gitlab.timeout',{ms:TIMEOUT_MS}), { code: 'gitlab-timeout' })
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/**
 * Fetch one merge request's changes.
 * @param config - loaded plugin config.
 * @param request - `{ mergeRequest, project? }`; mergeRequest may be a URL, an
 *   IID, or `!123`.
 * @returns `{ project, iid, title, webUrl, sourceBranch, targetBranch, changes }`
 *   where each change is `{ oldPath, newPath, newFile, deletedFile, renamedFile, diff }`.
 */
export async function fetchMergeRequest(config, request, signal) {
  const raw = String(request?.mergeRequest ?? '').trim()
  if (!raw) {
    throw new D365Error(t('gitlab.missingRequest'), {
      code: 'missing-merge-request',
      hint: t('gitlab.requestHint'),
    })
  }

  const parsed = parseMergeRequestUrl(raw)
  const projectPath = parsed?.project
    ?? String(request?.project ?? config.gitlab?.defaultProject ?? '').trim()
  const iid = parsed?.iid ?? raw.replace(/^!/, '')

  if (!projectPath) {
    throw new D365Error(t('gitlab.noProject'), {
      code: 'gitlab-no-project',
      hint: t('gitlab.projectHint'),
    })
  }
  if (!/^\d+$/.test(iid)) {
    throw new D365Error(t('gitlab.invalidIid',{iid}), {
      code: 'invalid-merge-request',
      hint: t('gitlab.iidHint'),
    })
  }

  const data = await gitlabGet(
    config,
    `/projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}/changes`,
    signal,
    { base: parsed?.base },
  )

  return {
    project: data?.project_id ? String(projectPath) : projectPath,
    iid,
    title: data?.title ?? '',
    webUrl: data?.web_url ?? (parsed ? raw.split('/diffs')[0] : ''),
    sourceBranch: data?.source_branch ?? '',
    targetBranch: data?.target_branch ?? '',
    changes: (data?.changes ?? []).map((change) => {
      const diff = String(change.diff ?? '')
      return {
        oldPath: change.old_path ?? change.new_path,
        newPath: change.new_path ?? change.old_path,
        newFile: change.new_file === true,
        deletedFile: change.deleted_file === true,
        renamedFile: change.renamed_file === true,
        diff,
        // GitLab omits or truncates the diff of very large files (and
        // `too_large` says so). An empty diff means "not returned", not "no
        // changes": the file has to be reported as unchecked instead of clean.
        diffMissing: !diff.trim(),
        tooLarge: change.too_large === true,
      }
    }),
  }
}

/**
 * Prove the configured token can reach the configured host.
 * @returns `{ ok, user?, error? }` — never throws, so the settings page can
 *   show the result next to the form.
 */
export async function checkGitlab(config) {
  try {
    const user = await gitlabGet(config, '/user')
    return { ok: true, user: user?.username ?? '', name: user?.name ?? '' }
  } catch (error) {
    return { ok: false, error: error.message, hint: error.hint }
  }
}
