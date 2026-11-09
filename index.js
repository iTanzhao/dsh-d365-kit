/**
 * `dsh-d365-kit` — D365 CE / Dataverse toolkit for DSH.
 *
 * Tools, one data path:
 *   d365_envs       which environments exist and whether they authenticate
 *   d365_metadata   the generic metadata query over a fixed resource catalogue
 *   d365_layers     the solution-layer stack behind any component
 *   d365_sync       snapshot an environment's metadata to local files
 *   d365_diff       compare two snapshots
 *   d365_configure  read/write the environment list (same storage as the UI)
 *   d365_write      prepare a metadata change, then confirm and apply it
 *   d365_migrate    assess what happens if a solution is imported into another environment
 *   d365_code_check what a merge request's changed scripts break in a target environment
 *   d365_refs       who references a field, script or plugin assembly
 *   d365_data       count / group / sample business records (needs `data.read`)
 *   d365_data_write create or patch one business record (needs `data.write`)
 *   d365_data_sync  move business records between environments (plan, then confirm)
 *   d365_invoke     call one action or function and return status + body (needs `message.invoke`)
 *   d365_trace      read plug-in trace logs to explain a failure (needs `data.read`)
 *   d365_contract   compare plugin registration / option values across environments
 *   d365_health     stuck jobs, running imports, recently installed solutions
 *   d365_reports    what this plugin wrote to disk, and how much space it takes
 *
 * Reads go through `lib/client.js`, which sends GET only and splits reads in
 * two: metadata (always allowed) and business records (needs `data.read` for
 * that environment, resolved by `lib/data-policy.js`). The single metadata
 * write path lives in `lib/write-actions.js` and always runs behind a plan that
 * a human approves; business record writes live in `lib/tool-data-write.js`,
 * are gated by `data.write`, and always ask for confirmation first.
 *
 * The Web UI half contributes a settings page ("D365 工具箱") that saves through
 * the same `lib/settings-store.js` functions as `d365_configure`, and reaches
 * the Host through the routes in `lib/settings-http.js`.
 */
import { register as registerEnvironments } from './lib/tool-environments.js'
import { register as registerMetadata } from './lib/tool-metadata.js'
import { register as registerLayers } from './lib/tool-layers.js'
import { register as registerSync } from './lib/tool-sync.js'
import { register as registerDiff } from './lib/tool-diff.js'
import { register as registerConfigure } from './lib/tool-configure.js'
import { register as registerWrite } from './lib/tool-write.js'
import { register as registerMigrate } from './lib/tool-migrate.js'
import { register as registerCodeCheck } from './lib/tool-code-check.js'
import { register as registerRefs } from './lib/tool-refs.js'
import { register as registerData } from './lib/tool-data.js'
import { register as registerDataWrite } from './lib/tool-data-write.js'
import { register as registerContract } from './lib/tool-contract.js'
import { register as registerHealth } from './lib/tool-health.js'
import { register as registerReports } from './lib/tool-reports.js'
import { register as registerDataSync } from './lib/tool-data-sync.js'
import { register as registerInvoke } from './lib/tool-invoke.js'
import { register as registerTrace } from './lib/tool-trace.js'
import { registerRoutes } from './lib/settings-http.js'
import { registerSkills } from './lib/skill.js'
import { setCapabilityResolver, setDataReadResolver, setDataWriteResolver, setMetadataReadResolver } from './lib/client.js'
import { makeAnyCapabilityResolver, makeDataReadResolver, makeDataWriteResolver, makeMetadataReadResolver } from './lib/data-policy.js'

export const name = 'dsh-d365-kit'

/** Tools are required; the HTTP carrier is looked up optionally via `ctx.get`. */
export const inject = ['tools']

/** Guards the route registration against the two attach paths colliding. */
let routesAttached = false

/**
 * Install the tools and, when a web server is present, the settings routes.
 * @param ctx - host context.
 * @param config - the `config` block from cordis.patch.yml.
 */
export function apply(ctx, config = {}) {
  const state = { rawConfig: config ?? {} }

  // Every request consults the policy file: metadata reads, business-record
  // reads and writes are separate capabilities granted per environment.
  setMetadataReadResolver(makeMetadataReadResolver(() => state.rawConfig))
  setDataReadResolver(makeDataReadResolver(() => state.rawConfig))
  setDataWriteResolver(makeDataWriteResolver(() => state.rawConfig))
  setCapabilityResolver(makeAnyCapabilityResolver(() => state.rawConfig))

  const disposers = [
    registerEnvironments(ctx, state),
    registerMetadata(ctx, state),
    registerLayers(ctx, state),
    registerSync(ctx, state),
    registerDiff(ctx, state),
    registerConfigure(ctx, state),
    registerWrite(ctx, state),
    registerMigrate(ctx, state),
    registerCodeCheck(ctx, state),
    registerRefs(ctx, state),
    registerData(ctx, state),
    registerDataWrite(ctx, state),
    registerDataSync(ctx, state),
    registerInvoke(ctx, state),
    registerTrace(ctx, state),
    registerContract(ctx, state),
    registerHealth(ctx, state),
    registerReports(ctx, state),
  ]

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        // A failed unregister must not block the remaining ones.
      }
    }
  })

  // The troubleshooting skill travels with the package: registering it here is
  // what makes installing the bundle enough, with no file to copy by hand.
  registerSkills(ctx)

  // Looked up rather than declared: a headless profile has no HTTP carrier and
  // must not keep the plugin inactive. The settings routes live on the
  // authenticated `/api` channel that `ctx.connection` owns.
  const attachRoutes = (host) => {
    if (routesAttached) return
    const connection = typeof host.get === 'function' ? host.get('connection') : undefined
    if (!connection) return
    // The write routes compare the browser Origin against this origin; without
    // it they refuse, which is the intended failure mode.
    let origin
    try {
      origin = typeof host.get === 'function' ? host.get('webServer')?.getOrigin?.() : undefined
    } catch {
      origin = undefined
    }
    routesAttached = true
    host.effect(() => {
      routesAttached = false
      return registerRoutes({ connection, origin }, state)
    })
  }
  if (typeof ctx.inject === 'function') ctx.inject(['connection'], attachRoutes)
  attachRoutes(ctx)
}
