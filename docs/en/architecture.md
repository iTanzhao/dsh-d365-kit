# Architecture and Development

**English** | [简体中文](../zh/architecture.md)

## Layout

One DSH bundle in two parts:

```
index.js      # Host side: registers the 15 tools, mounts the settings page HTTP routes
client.js     # Web side: settings page (six tabs, no build step, a browser module directly)
lib/*.js      # All Host-side logic (40 modules)
```

Zero runtime dependencies: only Node's built-in `fetch` / `fs` / `path`. No TypeScript, no bundler, no `node_modules`.

`cordis.patch.yml` declares the bundle and its default config (`configFile`, `timeoutMs`, `snapshotKeep`, `environments`);
`package.json`'s `dsh.bundle.patch` points at it, and `dsh.client` declares the Web-side entry.

## Module responsibilities

```
lib/
  client.js           Dataverse Web API client: URL building, paging, retries, permission gate, tokens
  auth.js             Entra ID client-credentials flow; tokens cached per credential fingerprint
  config.js           Config load/normalize; configFile fallback chain; secret resolution
  resources.js        Query definitions and field mappings for 19 metadata resource types
  runtime.js          makeClient(env, config), org info, version
  snapshot.js         Snapshot writing, manifest, snapshot directory
  retention.js        Retention policy, disk stats, cleanup, compaction
  write-policy.js     Capability table (CAPABILITIES) and per-environment authorization
  write-actions.js    Planner and executor for all writes (the only code that changes an environment)
  write-store.js      Plan and change-record read/write, plan state machine
  preflight.js        Pre-execution idle check (msdyn_solutionhistories)
  settings-store.js   Settings page data layer (environments, permissions, general params, GitLab)
  settings-http.js    Settings page routes (exact paths on the auth channel)
  contract.js         Contract fact reading, comparison, rendering
  migrate.js          Migration assessment (layer lookup per component)
  code-check.js       MR check (JS/TS)
  csharp-check.js     MR check (C#)
  refs.js             Reverse index (forms/views/flows/steps)
  health.js           Environment health
  gitlab.js           GitLab API (MR diff, connectivity)
  waivers.js          Contract waivers
  contract-history.js Drift trend
  tool-*.js           15 tools, one file per tool (or per related group)
```

## Data flow

```
agent calls d365_*  ──> tool-*.js ──> lib capability modules ──> client.js ──> Dataverse Web API
                            │                                                      │
                            └────────── summary + file paths <─────────────────────┘
                                                 │
                           .d365/{snapshots,diffs,reports,query,changes}
```

Design principles:

1. **Tools return a summary and a path; the body lands in a file** — do not stuff tens of MB of JSON into the conversation;
2. **Read-only first** — only `d365_write execute` and `d365_data_write` change an environment, and both require human approval;
3. **Decisions live in one place** — what can be seen and what can be changed are both decided at the request entry point in `lib/client.js`, so new tools cannot bypass them;
4. **Live beats snapshot** — "how is it now" questions such as drift, migration, and health read live data; snapshots are only for comparison across time or environments;
5. **Rules are data** — contract rules, retention policy, and the capability table are all table-driven; adding a rule does not change the flow.

## The path of one request

Take `d365_metadata resource=attributes` as an example:

```
tool-metadata.js
  → pickEnvironments(args)            select environments
  → loadConfig(state.rawConfig)       read config (done at every tool entry)
  → makeClient(env, config)           build the client
  → resources.js query definitions    build path/params
  → client.getPagedWithSelectFallback paging + column-name fallback
      → permission gate (non-metadata entity sets → data.read)
      → getAccessToken (cached per credential fingerprint)
      → fetch; 429/5xx retried per method
  → cross-environment alignment + summary
  → more than 12 rows writes .d365/query/*.json
```

## Adding a tool

```js
// lib/tool-demo.js
import { pickEnvironments } from './tool-metadata.js';   // or roll your own

export default function registerDemo(ctx, state) {
  const disposer = ctx.tools.register({
    name: 'd365_demo',
    description: 'One sentence on what question it answers.',
    parameters: {                    // must be a standard JSON Schema
      type: 'object',
      additionalProperties: false,
      required: ['entity'],
      properties: {
        entity: { type: 'string', description: 'Entity logical name' },
        environment: { type: 'string', description: 'Environment key' },
      },
    },
    output: {
      schema: {                      // likewise a standard JSON Schema
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
    },
    async execute(args, exec) {
      const config = await loadConfig(state.rawConfig);   // note: rawConfig
      ...
      return { text };
    },
  });
  ctx.effect(() => disposer);
}
```

Then import it in `index.js`, call `registerDemo(ctx, state)`, and add the disposer to the list.

DSH's hard requirements (all of these have bitten us):

| Requirement | Symptom |
| --- | --- |
| Both `parameters` and `output.schema` are standard JSON Schema (root `type: 'object'`, `required` is an array) | `schema must be a JSON Schema of 'type: "object"', got 'type: null'` |
| Output strictly matches `output.schema`: no extra fields, no `type: ['string','null']` | `value.x is not a declared property` / `type arrays are not supported` |
| Config comes from `state.rawConfig` (`index.js` passes `{ rawConfig }`) | Environments mysteriously missing, lists empty |
| Host-side changes require a plugin reload | Tool behavior is still the old one |

## Client (settings page)

`client.js` is a browser module: `window.__ModuleLoader__.load({ id: 'dsh-d365-kit', factory })`.

- The six tabs' panels are **mounted at the same time**, with inactive ones hidden by `display:none` — switching tabs does not lose edit state;
- Copy ships a built-in Chinese/English dictionary; `t()` computes on every call from `localeService.getLocale().active`, independent of whether `locale.register` succeeded;
- Language switches re-render by subscribing to locale changes;
- Every write operation carries `x-d365-meta-write: 1` (the Host uses it to reject requests that do not come from the settings page).

**The module id must match the package name**, otherwise the loader runs it as two modules, reports `duplicate factory registration`, and the whole settings page disappears.

## Local verification

Most logic can be tested without an environment: stub `globalThis.fetch` and `ctx.tools` and call the module functions directly.

```js
globalThis.fetch = async (url) => new Response(JSON.stringify({ value: [] }), { status: 200 });
```

Note: `new Response('', { status: 204 })` throws `Invalid response status code 204` in Node; for 204 use a `null` body.

Minimal set for verifying against a real environment:

```
d365_envs check=true
d365_metadata resource=entities top=2
d365_layers component=account componentType=Entity
d365_health environments=["<env>"]
```

## Known pitfalls (for the next person to change the code)

- Metadata endpoints do not accept `$top` / `$orderby`; the client degrades progressively. When writing a new query, prefer `getPagedWithSelectFallback`;
- `getPagedWithSelectFallback` returns `{ page, selectDropped, ... }`; the rows are in `result.page.records`;
- `odataString()` only escapes quotes and **does not add them**; write your own `'...'` in filters;
- `client.getOne()` appends `$top=1`, which returns 400 for `solutions` / `solutioncomponents`; use `requestJson` and page manually instead;
- Virtual/audit tables such as the layer table and `msdyn_solutionhistories` behave differently from normal tables; verify with a small sample first;
- Do not rewrite files containing non-ASCII with PowerShell 5.1 `Get-Content | Set-Content` (it re-encodes them as ANSI); use an editing tool;
- Writing `package.json` with `Set-Content -Encoding utf8` adds a BOM, and `JSON.parse` fails outright.
