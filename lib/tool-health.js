/**
 * Implementation behind `d365_diagnose` (the `health` action) — is the
 * environment busy, what failed recently, what got installed lately.
 * Read-only; meant to be run before a release.
 */

import { loadConfig } from './config.js'
import { D365Error } from './errors.js'
import { t } from './i18n.js'
import { readHealth } from './health.js'
import { writeArtifact } from './runtime.js'

function pickEnvironments(config, args) {
  const keys = Object.keys(config.environments)
  if (!keys.length) throw new D365Error('No D365 environments are configured', { i18nKey: 'health.noEnvironments', hintKey: 'health.addEnvironment' })
  if (args.allEnvironments === true) return keys
  if (Array.isArray(args.environments) && args.environments.length) {
    for (const key of args.environments) {
      if (!config.environments[key]) throw new D365Error(`Unknown environment: ${key}`, { i18nKey: 'health.unknownEnvironment', i18nParams: { key }, hintKey: 'health.available', hintParams: { values: keys.join(', ') } })
    }
    return args.environments
  }
  return [config.defaultEnvironment ?? keys[0]]
}

export async function run(state, args = {}, exec) {
  const config = await loadConfig(state.rawConfig)
  const keys = pickEnvironments(config, args)
  const rows = []
  for (const key of keys) {
    rows.push(await readHealth(config, key, { hours: args.hours, signal: exec.signal }))
  }
  const artifactPath = await writeArtifact(config, 'health', { generatedAt: new Date().toISOString(), rows })
  return { schemaVersion: 1, rows, artifactPath }
}
