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
  if (status === 401) return 'GitLab 令牌无效或已过期（HTTP 401）'
  if (status === 403) {
    return 'GitLab 拒绝了访问（HTTP 403）：令牌 scope 不足，或该用户在项目里的角色低于 Reporter'
      + '（项目访问令牌的角色若是 Guest，读不到 MR 与仓库）。把角色改成 Reporter 以上，或改用个人访问令牌'
  }
  if (status === 404) return 'GitLab 找不到项目或 MR（HTTP 404），检查项目路径与 IID'
  return `GitLab 返回 HTTP ${status}：${message}`
}

/**
 * Call one GitLab API path and parse JSON.
 * @param config - loaded plugin config (supplies `gitlab.url` and the secrets path).
 * @param path - path beginning with `/`, e.g. `/projects/g%2Fp`.
 */
export async function gitlabGet(config, path, signal) {
  const url = config.gitlab?.url
  const token = await readGitlabToken(config)
  if (!url) {
    throw new D365Error('没有配置 GitLab 地址', {
      code: 'gitlab-not-configured',
      hint: '在设置 →「D365 环境」→ GitLab 里填仓库地址与访问令牌。',
    })
  }
  if (!token.ok) {
    throw new D365Error('没有配置 GitLab 访问令牌', {
      code: 'gitlab-no-token',
      hint: '在设置页填只读令牌（read_api），或设置环境变量 D365_GITLAB_TOKEN。',
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
      throw new D365Error(`请求 GitLab 超时（${TIMEOUT_MS}ms）`, { code: 'gitlab-timeout' })
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
    throw new D365Error('缺少 mergeRequest', {
      code: 'missing-merge-request',
      hint: '传 MR 链接，或项目路径 + IID。',
    })
  }

  const parsed = parseMergeRequestUrl(raw)
  const projectPath = parsed?.project
    ?? String(request?.project ?? config.gitlab?.defaultProject ?? '').trim()
  const iid = parsed?.iid ?? raw.replace(/^!/, '')

  if (!projectPath) {
    throw new D365Error('无法确定 GitLab 项目', {
      code: 'gitlab-no-project',
      hint: '传完整的 MR 链接，或在设置页填默认项目（group/project）。',
    })
  }
  if (!/^\d+$/.test(iid)) {
    throw new D365Error(`MR IID 不是数字：${iid}`, {
      code: 'invalid-merge-request',
      hint: '例如 https://gitlab.example.com/group/project/-/merge_requests/42',
    })
  }

  const data = await gitlabGet(
    config,
    `/projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}/changes`,
    signal,
  )

  return {
    project: data?.project_id ? String(projectPath) : projectPath,
    iid,
    title: data?.title ?? '',
    webUrl: data?.web_url ?? (parsed ? raw.split('/diffs')[0] : ''),
    sourceBranch: data?.source_branch ?? '',
    targetBranch: data?.target_branch ?? '',
    changes: (data?.changes ?? []).map((change) => ({
      oldPath: change.old_path ?? change.new_path,
      newPath: change.new_path ?? change.old_path,
      newFile: change.new_file === true,
      deletedFile: change.deleted_file === true,
      renamedFile: change.renamed_file === true,
      diff: change.diff ?? '',
    })),
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
