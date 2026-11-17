/**
 * Decide whether one environment may touch business records.
 *
 * Metadata is readable by default; business tables need `data.read`, and
 * writing business records needs `data.write`. Both can be revoked per
 * environment. Each answer is cached for two seconds because a single tool call
 * can issue hundreds of requests; a policy saved in the settings page is picked
 * up when the cached entry expires.
 */
import { loadConfig } from './config.js'
import { allows, readPolicy } from './write-policy.js'

const TTL_MS = 2_000

/**
 * Build one decision function whose answers are cached per environment and
 * capability.
 *
 * Caching only the parsed policy still cost a `loadConfig` on every request
 * (two file reads and two JSON.parse calls) just to learn the config path, so
 * the whole answer is cached now. The key carries both the environment and the
 * capability: a `data.read` grant can never be served for `data.write`, and one
 * environment's answer is never returned for another.
 *
 * The TTL is the only invalidation. The policy is written by `savePolicy` in
 * write-policy.js from the route in settings-http.js; importing either from
 * here would create a cycle, so a saved change surfaces within two seconds
 * rather than immediately.
 *
 * @param getRawConfig - returns the plugin's raw config (so the config file can move).
 * @returns async function (envKey, capability) => boolean.
 */
function makeCachedDecision(getRawConfig) {
  const cache = new Map()

  return async function evaluate(envKey, capability) {
    const key = `${capability}\u0000${envKey}`
    const now = Date.now()
    const cached = cache.get(key)
    if (cached && now - cached.at <= TTL_MS) return cached.allowed

    const config = await loadConfig(getRawConfig() ?? {})
    const allowed = allows(await readPolicy(config.configFile ?? null), envKey, capability)
    cache.set(key, { at: now, allowed })
    return allowed
  }
}

/**
 * Build a resolver for one capability.
 *
 * @param getRawConfig - returns the plugin's raw config (so the config file can move).
 * @param capability - policy key, e.g. `data.read`.
 * @returns async function (envKey) => boolean.
 */
export function makeCapabilityResolver(getRawConfig, capability) {
  const decide = makeCachedDecision(getRawConfig)

  return async function allowsCapability(envKey) {
    try {
      return await decide(envKey, capability)
    } catch {
      return false
    }
  }
}

/** @returns async function (envKey) => boolean for `data.read`. */
export function makeDataReadResolver(getRawConfig) {
  return makeCapabilityResolver(getRawConfig, 'data.read')
}

/** @returns async function (envKey) => boolean for `data.write`. */
export function makeDataWriteResolver(getRawConfig) {
  return makeCapabilityResolver(getRawConfig, 'data.write')
}

/** @returns async function (envKey) => boolean for `metadata.read`. */
export function makeMetadataReadResolver(getRawConfig) {
  return makeCapabilityResolver(getRawConfig, 'metadata.read')
}

/**
 * Resolver for tools that name their capability on the request itself.
 *
 * `d365_invoke` passes `message.invoke` on its own request; instead of adding a
 * fourth resolver per capability, resolve any key from the same policy file.
 * @returns async function (envKey, capability) => boolean.
 */
export function makeAnyCapabilityResolver(getRawConfig) {
  const decide = makeCachedDecision(getRawConfig)

  return async function allowsAnyCapability(envKey, capability) {
    try {
      return await decide(envKey, capability)
    } catch {
      return false
    }
  }
}
