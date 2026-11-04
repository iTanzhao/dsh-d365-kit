/**
 * OAuth2 client-credentials tokens for Dataverse.
 *
 * One token per environment, cached until shortly before expiry. The token is
 * requested against the environment's own URL, which is what Dataverse
 * requires (a token for another environment is rejected with 401).
 */
import { createHash } from 'node:crypto'
import { resolveCredential } from './config.js'
import { D365Error } from './errors.js'

/** Cloud-specific Entra ID authorities. The resource scope is always the env URL. */
const AUTHORITY = {
  public: 'https://login.microsoftonline.com',
  usgovernment: 'https://login.microsoftonline.us',
  dod: 'https://login.microsoftonline.us',
  china: 'https://login.partner.microsoftonline.cn',
}

export const KNOWN_CLOUDS = Object.keys(AUTHORITY)

/** @type {Map<string, { token: string, expiresAt: number, fingerprint: string }>} */
const tokenCache = new Map()

/**
 * Fingerprint of the values a token was minted from.
 *
 * Changing the application user in the settings page must take effect on the
 * next call, but the token cache outlives a settings save (and a plugin reload
 * reuses the module). Comparing this fingerprint makes a cached token
 * unusable as soon as the url, tenant, client id or secret changes.
 */
function credentialFingerprint(env) {
  const parts = ['tenantId', 'clientId', 'clientSecret'].map((kind) => {
    const resolved = resolveCredential(env, kind)
    return resolved.ok ? resolved.value : ''
  })
  if (parts.some((part) => !part)) return undefined
  return createHash('sha256').update([env.url, ...parts].join('\u0000')).digest('hex')
}

/**
 * Drop a cached token so the next call re-authenticates.
 * @param envKey - environment key.
 */
export function forgetToken(envKey) {
  tokenCache.delete(envKey)
}

function requireCredential(env, kind) {
  const resolved = resolveCredential(env, kind)
  if (resolved.ok) return resolved.value
  throw new D365Error(
    `环境 ${env.key} 缺少 ${kind}（找不到 ${resolved.missing.join(' 或 ')}）`,
    {
      code: 'missing-credential',
      hint: `在配置里写 ${kind}Env: '${resolved.missing[0]}'，并在启动 harness 的环境中设置该变量。`,
    },
  )
}

/**
 * Acquire (or reuse) an access token for one environment.
 * @param env - normalized environment.
 * @param options - `force` bypasses the cache.
 * @returns a bearer token string.
 */
export async function getAccessToken(env, options = {}) {
  const fingerprint = credentialFingerprint(env)
  const cached = tokenCache.get(env.key)
  if (
    !options.force
    && cached
    && fingerprint
    && cached.fingerprint === fingerprint
    && cached.expiresAt - 60_000 > Date.now()
  ) {
    return cached.token
  }

  const tenant = requireCredential(env, 'tenantId')
  const clientId = requireCredential(env, 'clientId')
  const clientSecret = requireCredential(env, 'clientSecret')

  const authority = (env.authorityHost ?? AUTHORITY[env.cloud] ?? AUTHORITY.public).replace(/\/+$/, '')
  const url = `${authority}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: `${env.url}/.default`,
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    })
  } catch (error) {
    throw new D365Error(`环境 ${env.key} 获取令牌失败：${error.message}`, {
      code: 'token-network',
      hint: `确认能访问 ${authority}；企业代理需要放行登录与 *.dynamics.com。`,
    })
  } finally {
    clearTimeout(timer)
  }

  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new D365Error(`环境 ${env.key} 获取令牌失败：HTTP ${response.status}，响应不是 JSON`, {
      code: 'token-http',
    })
  }

  if (!response.ok) {
    const detail = payload?.error_description ?? payload?.error ?? text.slice(0, 400)
    throw new D365Error(`环境 ${env.key} 获取令牌失败：HTTP ${response.status} — ${detail}`, {
      code: 'token-http',
      status: response.status,
      hint: '常见原因：密钥过期、应用用户未在目标环境启用、或该环境 URL 与租户不匹配。',
    })
  }

  const token = payload?.access_token
  if (!token) {
    throw new D365Error(`环境 ${env.key} 获取令牌失败：响应中没有 access_token`, { code: 'token-shape' })
  }

  const lifetimeMs = Number(payload.expires_in) > 0 ? Number(payload.expires_in) * 1000 : 3600_000
  tokenCache.set(env.key, {
    token,
    expiresAt: Date.now() + lifetimeMs,
    fingerprint: credentialFingerprint(env) ?? '',
  })
  return token
}
