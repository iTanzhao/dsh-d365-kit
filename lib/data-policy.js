/**
 * Decide whether one environment may touch business records.
 *
 * Metadata is always readable; business tables need `data.read`, and writing
 * business records needs `data.write`. The answer is cached for a moment
 * because a single tool call can issue hundreds of requests, and the settings
 * page may change the policy at any time.
 */
import { loadConfig } from './config.js'
import { allows, readPolicy } from './write-policy.js'

const TTL_MS = 2_000

/**
 * Build a resolver for one capability.
 *
 * @param getRawConfig - returns the plugin's raw config (so the config file can move).
 * @param capability - policy key, e.g. `data.read`.
 * @returns async function (envKey) => boolean.
 */
export function makeCapabilityResolver(getRawConfig, capability) {
  let cache = { path: undefined, at: 0, policy: null }

  return async function allowsCapability(envKey) {
    try {
      const config = await loadConfig(getRawConfig() ?? {})
      const path = config.configFile ?? null
      const now = Date.now()
      if (cache.path !== path || now - cache.at > TTL_MS) {
        cache = { path, at: now, policy: await readPolicy(path) }
      }
      return allows(cache.policy, envKey, capability)
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
