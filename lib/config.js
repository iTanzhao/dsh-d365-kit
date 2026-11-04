/**
 * Configuration loading and credential resolution.
 *
 * The plugin never stores a secret in the patch: the patch is a plain-text
 * file that ends up in a profile directory and, in this project's case, in
 * Git. Configuration names environment variables; the values live in the
 * process environment.
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DEFAULT_RETENTION } from './retention-defaults.js'
import { DEFAULT_BUSY_WINDOW_MINUTES } from './preflight.js'

export const DEFAULT_TIMEOUT_MS = 60_000
export const DEFAULT_MAX_RECORDS = 200

/** How many snapshots to keep per environment before pruning the oldest. */
export const DEFAULT_SNAPSHOT_KEEP = 2
/** Environment-variable suffix used by the derived `D365_<ENV>_<SUFFIX>` names. */
const CREDENTIAL_SUFFIX = {
  tenantId: 'TENANT_ID',
  clientId: 'CLIENT_ID',
  clientSecret: 'CLIENT_SECRET',
}

/** File beside the config file that holds secrets typed into the settings UI. */
export const SECRETS_FILENAME = 'd365.secrets.json'

/**
 * Where `d365.config.json` lives when the installed patch does not name it.
 *
 * A bundle installed by somebody else must not carry this machine's absolute
 * path, and the harness process working directory is its profile directory, so
 * neither the patch nor `cwd` is a usable default. Candidates, in order:
 * `D365_CONFIG_FILE`, the default DSH workspace under the user's Documents,
 * then `cwd`. The directory has to exist for the settings page to create the
 * file in it; a file that is not there yet is normal on a fresh install.
 */
export function defaultConfigFile() {
  const fromEnv = typeof process.env.D365_CONFIG_FILE === 'string' ? process.env.D365_CONFIG_FILE.trim() : ''
  if (fromEnv) return fromEnv
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (home) {
    const candidate = join(home, 'Documents', 'deepseek-harness', 'default-workspace', 'd365.config.json')
    if (existsSync(dirname(candidate))) return candidate
  }
  return join(process.cwd(), 'd365.config.json')
}

/**
 * Directory local data (snapshots, query artifacts) lives under.
 *
 * The config file's own directory is the fallback because the harness process
 * working directory is its profile directory, not the project: artifacts must
 * land next to the file the user edits. An explicit `workspaceDir` wins.
 */
export function dataDirectory(config) {
  if (config.workspaceDir) return config.workspaceDir
  if (config.configFile) return dirname(config.configFile)
  return process.cwd()
}

/**
 * Secrets loaded from the local secrets file, keyed `${envKey}:${kind}`.
 *
 * They live in a module-level map rather than in the config object so that a
 * resolved environment can never be serialised with its secret attached: the
 * tools report environment shapes, and only `resolveCredential` touches this.
 */
const secretOverlay = new Map()

export function setStoredSecret(envKey, kind, value) {
  if (value) secretOverlay.set(`${envKey}:${kind}`, value)
  else secretOverlay.delete(`${envKey}:${kind}`)
}

export function forgetStoredSecrets(envKey) {
  for (const key of [...secretOverlay.keys()]) {
    if (key.startsWith(`${envKey}:`)) secretOverlay.delete(key)
  }
}

const CREDENTIAL_LABEL = {
  tenantId: '租户 ID',
  clientId: '应用用户 ClientId',
  clientSecret: '客户端密钥',
}

/**
 * Normalize the optional GitLab block.
 *
 * The repository URL and the default project are not secrets, so they live in
 * the config file; the access token is stored beside it in the secrets file.
 */
export function normalizeGitlab(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    url: text(source.url)?.replace(/\/+$/, '') ?? null,
    defaultProject: text(source.defaultProject)?.replace(/^\/+|\/+$/g, '') ?? null,
  }
}

/**
 * Resolve the GitLab access token: environment first, then the secrets file.
 *
 * Environment variables win so CI or a shared machine can inject a token
 * without touching a file.
 */
export async function readGitlabToken(config) {
  for (const name of ['D365_GITLAB_TOKEN', 'GITLAB_TOKEN']) {
    if (process.env[name]) return { ok: true, value: process.env[name], source: `env:${name}` }
  }
  const path = config.secretsPath
    ?? (config.configFile ? join(dirname(config.configFile), SECRETS_FILENAME) : null)
  if (!path) return { ok: false, missing: ['D365_GITLAB_TOKEN'] }
  const secrets = await readSecrets(path)
  const token = typeof secrets.gitlabToken === 'string' ? secrets.gitlabToken.trim() : ''
  return token ? { ok: true, value: token, source: 'secrets' } : { ok: false, missing: ['D365_GITLAB_TOKEN'] }
}

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** Same as `positiveNumber`, but zero is meaningful (keep nothing). */
function nonNegativeNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** A list of non-empty strings, falling back to `fallback` when absent/empty. */
function stringList(value, fallback) {
  if (!Array.isArray(value)) return fallback
  const items = value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
  return items.length ? items : fallback
}

/**
 * Normalize one raw config object (patch config or config file) into the shape
 * the rest of the plugin consumes. Nothing here touches the filesystem.
 * @param raw - the raw config value handed to the plugin.
 * @returns normalized config plus a list of human-readable problems.
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const issues = []
  const environments = {}

  for (const [key, value] of Object.entries(source.environments ?? {})) {
    const entry = value && typeof value === 'object' ? value : {}
    const url = text(entry.url)?.replace(/\/+$/, '')
    if (!url) {
      issues.push(`环境 "${key}" 缺少 url，已忽略`)
      continue
    }
    environments[key] = {
      key,
      label: text(entry.label) ?? key,
      url,
      cloud: text(entry.cloud) ?? 'public',
      authorityHost: text(entry.authorityHost),
      tenantId: text(entry.tenantId),
      tenantIdEnv: text(entry.tenantIdEnv),
      clientId: text(entry.clientId),
      clientIdEnv: text(entry.clientIdEnv),
      clientSecret: text(entry.clientSecret),
      clientSecretEnv: text(entry.clientSecretEnv),
      note: text(entry.note),
    }
  }

  const keys = Object.keys(environments)
  const requestedDefault = text(source.defaultEnvironment)
  const defaultEnvironment = requestedDefault && keys.includes(requestedDefault)
    ? requestedDefault
    : keys[0]

  if (requestedDefault && !keys.includes(requestedDefault) && keys.length) {
    issues.push(`defaultEnvironment "${requestedDefault}" 不在 environments 中，已回退到 ${keys[0] ?? '（无）'}`)
  }

  return {
    environments,
    defaultEnvironment,
    timeoutMs: positiveNumber(source.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxRecords: positiveNumber(source.maxRecords, DEFAULT_MAX_RECORDS),
    configFile: text(source.configFile),
    workspaceDir: text(source.workspaceDir),
    snapshotKeep: positiveNumber(source.snapshotKeep, DEFAULT_SNAPSHOT_KEEP),
    busyWindowMinutes: positiveNumber(source.busyWindowMinutes, DEFAULT_BUSY_WINDOW_MINUTES),
    snapshotMaxAgeDays: positiveNumber(source.snapshotMaxAgeDays, DEFAULT_RETENTION.snapshotMaxAgeDays),
    reportKeep: nonNegativeNumber(source.reportKeep, DEFAULT_RETENTION.reportKeep),
    reportMaxAgeDays: positiveNumber(source.reportMaxAgeDays, DEFAULT_RETENTION.reportMaxAgeDays),
    diffKeep: nonNegativeNumber(source.diffKeep, DEFAULT_RETENTION.diffKeep),
    diffMaxAgeDays: positiveNumber(source.diffMaxAgeDays, DEFAULT_RETENTION.diffMaxAgeDays),
    queryKeep: nonNegativeNumber(source.queryKeep, DEFAULT_RETENTION.queryKeep),
    queryMaxAgeDays: positiveNumber(source.queryMaxAgeDays, DEFAULT_RETENTION.queryMaxAgeDays),
    changeKeep: nonNegativeNumber(source.changeKeep, DEFAULT_RETENTION.changeKeep),
    changeMaxAgeDays: positiveNumber(source.changeMaxAgeDays, DEFAULT_RETENTION.changeMaxAgeDays),
    warnMegabytes: positiveNumber(source.warnMegabytes, DEFAULT_RETENTION.warnMegabytes),
    gitlab: normalizeGitlab(source.gitlab),
    // Publisher prefixes whose script libraries belong to this project. The
    // handler check only judges these; platform-injected handlers from system
    // libraries are skipped (they are not in the resource a form lists).
    // Leave it empty to infer the prefixes from the source environment's
    // unmanaged solutions, i.e. the publishers the project actually uses.
    handlerPrefixes: stringList(source.handlerPrefixes, []),
    issues,
  }
}

/**
 * Resolve one credential for an environment without throwing, so callers can
 * report *why* an environment is unusable.
 * @param env - normalized environment.
 * @param kind - which credential to resolve.
 * @returns the value and where it came from, or the names that were missing.
 */
export function resolveCredential(env, kind) {
  const inline = env[kind]
  if (inline) return { ok: true, value: inline, source: 'config' }

  const stored = secretOverlay.get(`${env.key}:${kind}`)
  if (stored) return { ok: true, value: stored, source: 'secrets' }

  const named = env[`${kind}Env`]
  if (named) {
    const value = process.env[named]
    if (value) return { ok: true, value, source: `env:${named}` }
    return { ok: false, missing: [named] }
  }

  const upper = env.key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  const derived = `D365_${upper}_${CREDENTIAL_SUFFIX[kind]}`
  if (process.env[derived]) return { ok: true, value: process.env[derived], source: `env:${derived}` }

  const shared = `D365_${CREDENTIAL_SUFFIX[kind]}`
  if (process.env[shared]) return { ok: true, value: process.env[shared], source: `env:${shared}` }

  return { ok: false, missing: [derived, shared] }
}

/**
 * Human-readable credential status for the `d365_envs` tool.
 * @param env - normalized environment.
 * @returns per-credential status, plus whether the environment could authenticate.
 */
export function credentialStatus(env) {
  const status = {}
  let complete = true
  for (const kind of ['tenantId', 'clientId', 'clientSecret']) {
    const resolved = resolveCredential(env, kind)
    status[kind] = resolved.ok
      ? { ok: true, source: resolved.source }
      : { ok: false, missing: resolved.missing }
    if (!resolved.ok) complete = false
  }
  return { complete, credentials: status, label: CREDENTIAL_LABEL }
}

/**
 * Merge the patch config with an optional JSON config file.
 *
 * The file wins on conflicts: it is the per-machine, per-project file a human
 * edits, while the patch ships defaults. A missing or broken file is reported
 * as an issue rather than thrown, because the read-only tools should still be
 * able to explain what is wrong.
 * @param raw - patch config.
 * @returns normalized config, possibly enriched from the file.
 */
export async function loadConfig(raw) {
  const base = normalizeConfig(raw)
  const path = base.configFile
    ? (isAbsolute(base.configFile) ? base.configFile : resolve(process.cwd(), base.configFile))
    : defaultConfigFile()
  try {
    // Notepad and many Windows editors save UTF-8 with a BOM, which
    // JSON.parse rejects; strip it so a hand-edited config still loads.
    const text = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text)
    // Merge the raw objects, then normalize once: normalizing both sides first
    // would replace "absent" with defaults and make the file silently win on
    // settings it never mentioned.
    const mergedRaw = { ...(raw && typeof raw === 'object' ? raw : {}), ...(parsed && typeof parsed === 'object' ? parsed : {}) }
    mergedRaw.environments = { ...(raw?.environments ?? {}), ...(parsed?.environments ?? {}) }
    const merged = normalizeConfig(mergedRaw)

    // Secrets are stored beside the config file, never inside it.
    const secretsPath = join(dirname(path), SECRETS_FILENAME)
    const secrets = await readSecrets(secretsPath)
    for (const envKey of Object.keys(merged.environments)) {
      forgetStoredSecrets(envKey)
      setStoredSecret(envKey, 'clientSecret', secrets[envKey]?.clientSecret)
    }

    return { ...merged, configFile: path, secretsPath }
  } catch (error) {
    return {
      ...base,
      configFile: path,
      issues: [...base.issues, `读取 configFile 失败 (${path}): ${error.message}`],
    }
  }
}

/**
 * Read the optional secrets file. A missing file is normal (nobody typed a
 * secret yet); a broken one is reported through the config issues of the
 * caller's next load, never thrown mid-request.
 */
async function readSecrets(path) {
  try {
    const text = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
