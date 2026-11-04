/**
 * Reading and writing the D365 environment list.
 *
 * One operation, two callers: the settings page in the Web UI and the
 * `d365_configure` tool both go through these functions, so the UI can never
 * drift from what the agent writes.
 *
 * Split of storage:
 *   - `d365.config.json`  — url, label, cloud, tenantId, clientId, default env.
 *   - `d365.secrets.json` — client secrets typed into the form.
 *
 * The split exists so the file a team commits to Git never carries a secret.
 * The secrets file is plain text: it is protected by living outside the
 * committed config and by a tightened mode where the filesystem supports one
 * (Node's `chmod` is a no-op for permissions on Windows).
 */
import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { credentialStatus, dataDirectory, loadConfig, readGitlabToken, SECRETS_FILENAME } from './config.js'
import { readOrganization } from './runtime.js'
import { DataverseClient } from './client.js'
import { D365Error } from './errors.js'

const KNOWN_CLOUDS = ['public', 'usgovernment', 'dod', 'china']

/** Read one JSON file, returning `fallback` when it is missing or unreadable. */
async function readJson(path, fallback) {
  try {
    return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}

/** Write JSON through a temp file so a crashed write cannot truncate config. */
async function writeJson(path, value, mode) {
  const temp = `${path}.tmp-${process.pid}`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  if (mode) await chmod(temp, mode)
  await rename(temp, path)
}

/** One environment as the settings page shows it — never includes a secret. */
function describeEnvironment(env) {
  const status = credentialStatus(env)
  const secret = status.credentials.clientSecret
  return {
    key: env.key,
    label: env.label,
    url: env.url,
    cloud: env.cloud,
    note: env.note ?? '',
    tenantId: env.tenantId ?? '',
    tenantIdEnv: env.tenantIdEnv ?? '',
    clientId: env.clientId ?? '',
    clientIdEnv: env.clientIdEnv ?? '',
    hasSecret: secret.ok,
    secretSource: secret.ok ? secret.source : undefined,
    secretMissing: secret.ok ? [] : secret.missing,
    complete: status.complete,
    missing: Object.entries(status.credentials)
      .filter(([, value]) => !value.ok)
      .map(([kind, value]) => ({ kind, missing: value.missing })),
  }
}

/** The whole settings surface, safe to send to a browser. */
export async function readSettings(rawConfig) {
  const config = await loadConfig(rawConfig)
  return {
    configFile: config.configFile ?? null,
    secretsFile: config.secretsPath ?? join(dirname(config.configFile ?? '.'), SECRETS_FILENAME),
    defaultEnvironment: config.defaultEnvironment ?? null,
    issues: config.issues,
    clouds: KNOWN_CLOUDS,
    // Tool parameters that used to be patch-only. They are not per-environment,
    // so they live beside the environment list in the same config file.
    general: {
      snapshotKeep: config.snapshotKeep,
      maxRecords: config.maxRecords,
      timeoutMs: config.timeoutMs,
      dataDirectory: dataDirectory(config),
    },
    environments: Object.values(config.environments).map(describeEnvironment),
    // Code-repository access used by the diff-driven code check. The token is
    // reported as presence only: the browser never receives the value.
    gitlab: await describeGitlab(config),
  }
}

/** GitLab settings as the page shows them, including whether a token exists. */
async function describeGitlab(config) {
  const token = await readGitlabToken(config)
  return {
    url: config.gitlab?.url ?? '',
    defaultProject: config.gitlab?.defaultProject ?? '',
    hasToken: token.ok,
    tokenSource: token.ok ? token.source : undefined,
    tokenMissing: token.ok ? [] : token.missing,
  }
}

/** Bounds for the general numbers, so a typo cannot disable pruning or timeouts. */
const GENERAL_LIMITS = {
  snapshotKeep: { min: 1, max: 50, label: '快照保留份数' },
  maxRecords: { min: 1, max: 100000, label: '单次返回行数上限' },
  timeoutMs: { min: 5000, max: 300000, label: '请求超时（毫秒）' },
}

/** Copy the validated general numbers from `incoming` into `target`. */
function applyGeneral(target, incoming) {
  for (const [key, limit] of Object.entries(GENERAL_LIMITS)) {
    if (!(key in (incoming ?? {}))) continue
    const value = Number(incoming[key])
    if (!Number.isInteger(value) || value < limit.min || value > limit.max) {
      throw new D365Error(`${limit.label}必须是 ${limit.min}–${limit.max} 之间的整数`, {
        code: 'invalid-setting',
        hint: `收到的是 ${JSON.stringify(incoming[key])}`,
      })
    }
    target[key] = value
  }
  return target
}

/**
 * Persist tool parameters without touching the environment list.
 *
 * Separate from `saveSettings` on purpose: a page section that only edits
 * "keep N snapshots" must never be able to rewrite (or accidentally drop) the
 * environments it did not load.
 */
export async function saveGeneral(rawConfig, general) {
  const current = await loadConfig(rawConfig)
  if (!current.configFile) {
    throw new D365Error('插件没有配置 configFile，无法保存', {
      code: 'no-config-file',
      hint: '在 cordis.patch.yml 的 config.configFile 指定 d365.config.json 的绝对路径。',
    })
  }
  const file = await readJson(current.configFile, {})
  applyGeneral(file, general)
  await writeJson(current.configFile, file)
  return readSettings(rawConfig)
}

/**
 * Persist the GitLab block: URL and default project in the config file, the
 * access token in the secrets file.
 *
 * Kept separate from `saveSettings` for the same reason as `saveGeneral`: a
 * form that only edits the repository settings must not rewrite environments.
 */
export async function saveGitlab(rawConfig, input) {
  const current = await loadConfig(rawConfig)
  if (!current.configFile) {
    throw new D365Error('插件没有配置 configFile，无法保存', {
      code: 'no-config-file',
      hint: '在 cordis.patch.yml 的 config.configFile 指定 d365.config.json 的绝对路径。',
    })
  }

  const file = await readJson(current.configFile, {})
  const url = String(input?.url ?? '').trim().replace(/\/+$/, '')
  const project = String(input?.defaultProject ?? '').trim().replace(/^\/+|\/+$/g, '')

  if (url && !/^https:\/\/[^\s/]+/i.test(url)) {
    throw new D365Error('GitLab 地址必须以 https:// 开头', {
      code: 'invalid-gitlab',
      hint: `收到的是 ${JSON.stringify(input?.url ?? '')}`,
    })
  }
  if (project && !/^[\w.-]+(\/[\w.-]+)+$/.test(project)) {
    throw new D365Error('默认项目要写成 group/project 的形式', {
      code: 'invalid-gitlab',
      hint: `收到的是 ${JSON.stringify(project)}`,
    })
  }

  const gitlab = { ...(file.gitlab ?? {}) }
  // Only fields the caller actually sent are touched: clearing the token must
  // not silently drop the address and project it belongs to.
  if (input?.url !== undefined) {
    if (url) gitlab.url = url
    else delete gitlab.url
  }
  if (input?.defaultProject !== undefined) {
    if (project) gitlab.defaultProject = project
    else delete gitlab.defaultProject
  }
  if (Object.keys(gitlab).length) file.gitlab = gitlab
  else delete file.gitlab
  await writeJson(current.configFile, file)

  const secretsPath = current.secretsPath ?? join(dirname(current.configFile), SECRETS_FILENAME)
  const secrets = await readJson(secretsPath, {})
  const token = typeof input?.token === 'string' ? input.token.trim() : ''
  if (token) secrets.gitlabToken = token
  else if (input?.clearToken) delete secrets.gitlabToken

  if (Object.keys(secrets).length) await writeJson(secretsPath, secrets, 0o600)
  else await unlink(secretsPath).catch(() => {})
  if (token) await appendGitignore(dirname(current.configFile))

  return readSettings(rawConfig)
}

/** Reject a row the UI could have caught, with a message naming the row. */
function validateRow(key, row) {
  const problems = []
  const url = String(row?.url ?? '').trim().replace(/\/+$/, '')
  if (!url) problems.push('缺少 URL')
  else if (!/^https:\/\/[^\s/]+/i.test(url)) problems.push('URL 必须以 https:// 开头')
  const cloud = String(row?.cloud ?? 'public').trim() || 'public'
  if (!KNOWN_CLOUDS.includes(cloud)) problems.push(`cloud 只能是 ${KNOWN_CLOUDS.join(' / ')}`)
  if (problems.length) {
    throw new D365Error(`环境 "${key}" 配置有误：${problems.join('；')}`, {
      code: 'invalid-environment',
      hint: '例如 https://contoso-dev.crm5.dynamics.com',
    })
  }
  return { url, cloud }
}

/**
 * Persist the environment list.
 *
 * @param rawConfig - the plugin's patch config (supplies `configFile`).
 * @param payload - `{ defaultEnvironment, environments: { key: row } }` where a
 *   row may carry `clientSecret` (write it) or `clearSecret` (remove it).
 * @returns the new settings view plus what changed.
 */
export async function saveSettings(rawConfig, payload) {
  const current = await loadConfig(rawConfig)
  if (!current.configFile) {
    throw new D365Error('插件没有配置 configFile，无法保存', {
      code: 'no-config-file',
      hint: '在 cordis.patch.yml 的 config.configFile 指定 d365.config.json 的绝对路径。',
    })
  }

  const incoming = payload?.environments && typeof payload.environments === 'object' ? payload.environments : {}
  const existing = await readJson(current.configFile, {})

  const environments = {}
  for (const [rawKey, rawRow] of Object.entries(incoming)) {
    const key = String(rawKey).trim()
    if (!key) continue
    const { url, cloud } = validateRow(key, rawRow)
    const previous = existing.environments?.[key] ?? {}
    const row = { ...previous, url }
    row.cloud = cloud
    row.label = String(rawRow?.label ?? '').trim() || previous.label || key
    // Empty optional strings are removed rather than stored: a stray "" in the
    // file would win over the environment-variable fallback for that value.
    for (const field of ['tenantId', 'tenantIdEnv', 'clientId', 'clientIdEnv', 'note']) {
      const value = String(rawRow?.[field] ?? '').trim()
      if (value) row[field] = value
      else delete row[field]
    }
    if (cloud === 'public') delete row.cloud
    environments[key] = row
  }

  const keys = Object.keys(environments)
  const wantedDefault = String(payload?.defaultEnvironment ?? '').trim()
  const defaultEnvironment = keys.includes(wantedDefault)
    ? wantedDefault
    : (keys.includes(existing.defaultEnvironment) ? existing.defaultEnvironment : keys[0])

  const nextConfig = { ...existing, environments }
  if (defaultEnvironment) nextConfig.defaultEnvironment = defaultEnvironment
  else delete nextConfig.defaultEnvironment

  await writeJson(current.configFile, nextConfig)

  // Secrets: only rows that sent one, plus explicit removals.
  const secretsPath = current.secretsPath ?? join(dirname(current.configFile), SECRETS_FILENAME)
  const secrets = await readJson(secretsPath, {})
  const changedSecrets = []
  for (const [rawKey, rawRow] of Object.entries(incoming)) {
    const key = String(rawKey).trim()
    if (!key || !environments[key]) continue
    const secret = typeof rawRow?.clientSecret === 'string' ? rawRow.clientSecret.trim() : ''
    if (secret) {
      secrets[key] = { ...(secrets[key] ?? {}), clientSecret: secret }
      changedSecrets.push(key)
    } else if (rawRow?.clearSecret) {
      if (secrets[key]) {
        delete secrets[key].clientSecret
        if (!Object.keys(secrets[key]).length) delete secrets[key]
        changedSecrets.push(key)
      }
    }
  }
  // A removed environment loses its secret too, so re-adding the key cannot
  // silently inherit the old credential.
  for (const key of Object.keys(secrets)) {
    // `gitlabToken` is not tied to an environment; it must survive an
    // environment removal.
    if (key === 'gitlabToken') continue
    if (!environments[key]) {
      delete secrets[key]
      changedSecrets.push(key)
    }
  }

  if (Object.keys(secrets).length) await writeJson(secretsPath, secrets, 0o600)
  else await unlink(secretsPath).catch(() => {})

  if (changedSecrets.length) await appendGitignore(dirname(current.configFile))

  // Reload through the normal path so the token cache and the credential
  // overlay see the new values immediately.
  const view = await readSettings(rawConfig)
  return { settings: view, saved: true, secretsTouched: [...new Set(changedSecrets)] }
}

/** Keep the secrets file out of Git when the project already has a .gitignore. */
async function appendGitignore(directory) {
  const path = join(directory, '.gitignore')
  try {
    const text = await readFile(path, 'utf8')
    if (text.split(/\r?\n/).some((line) => line.trim() === SECRETS_FILENAME)) return
    const join1 = text.endsWith('\n') ? '' : '\n'
    await writeFile(path, `${text}${join1}\n# D365 client secrets typed into the settings page\n${SECRETS_FILENAME}\n`, 'utf8')
  } catch {
    // No .gitignore here: nothing to protect, and creating one uninvited would
    // be surprising. The settings page says where the file lives.
  }
}

/**
 * Prove one environment can authenticate and read metadata.
 * @returns `{ ok, organization?, error?, hint?, missing? }` — never throws, so
 *   the settings page can show the failure next to the row.
 */
export async function checkEnvironment(rawConfig, key) {
  const config = await loadConfig(rawConfig)
  const env = config.environments[key]
  if (!env) {
    return { ok: false, error: `没有名为 ${key} 的环境`, missing: [] }
  }

  const status = credentialStatus(env)
  if (!status.complete) {
    return {
      ok: false,
      error: '凭据不全，无法连接',
      missing: Object.entries(status.credentials)
        .filter(([, value]) => !value.ok)
        .map(([kind, value]) => ({ kind, missing: value.missing })),
    }
  }

  try {
    const client = new DataverseClient(env, { timeoutMs: config.timeoutMs })
    const organization = await readOrganization(client)
    return { ok: true, organization }
  } catch (error) {
    return { ok: false, error: error.message, hint: error.hint }
  }
}
