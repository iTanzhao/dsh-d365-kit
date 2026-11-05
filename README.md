# dsh-d365-kit (D365 Toolkit)

**English** | [简体中文](README.zh-CN.md)

A **development and deployment assistant** for Dynamics 365 CE / Dataverse, installed as a [DeepSeek Harness](https://github.com/deepseek-ai) bundle.
It turns a real D365 organization into something an agent can query directly: metadata, solution layers, snapshot diffs, references, migration risk, the impact of code changes, and controlled writes.

> Sixteen tools, one settings page. Read-only by default: tick a capability and it may do exactly that — even metadata reads are a tick of "Read metadata", on by default.

```
You: which forms and views still use the contoso_customertier field on account in DEV?
agent: 17 forms, 64 views (62 columns / 50 filters), 0 business processes …
```

---

## What problem it solves

Most day-to-day friction in D365 projects is not "can't write code", it is **information asymmetry between environments**:

| Problem | How this plugin answers |
| --- | --- |
| If I ship this solution to SIT, will it override another solution's customizations? | `d365_migrate` checks layers component by component, listing the solutions that will be shadowed, the components that are missing, and the option values that will be lost |
| Why is the same form different in two environments? | `d365_layers` tells you who overrode it, `d365_diff` gives you the field-level differences |
| Will deleting this field break something? | `d365_refs` reverse-looks-up forms / views / processes / plugin steps, `d365_data` shows how many records still use it |
| Will this MR run once deployed to UAT? | `d365_code_check` maps JS to web resources and forms, and C# to assemblies/types/steps/images |
| Upstream changed a plugin — has downstream caught up? | `d365_contract` treats upstream registrations as a contract and compares them item by item downstream, with waivers and trends |
| Can we deploy right now? | `d365_health` shows suspended imports/publishes and failed jobs; the pre-flight check before writes uses the same data |
| Need to add a field / option value / view column? | `d365_write` produces a plan → a human confirms in the conversation → only then does it write, with a queryable audit trail afterwards |

---

## Feature overview

### Connectivity and environments

| Tool | Purpose |
| --- | --- |
| `d365_envs` | Environment inventory, whether credentials are complete; with `check: true` it actually connects once |
| `d365_configure` | Add, edit or remove environments (URL, tenant, ClientId, secret), test connectivity |
| `d365_health` | Suspended/failed background jobs, in-progress import publishes, recently installed solutions |

### Metadata and solution layers

| Tool | Purpose |
| --- | --- |
| `d365_metadata` | 19 resource kinds: entities, attributes, relationships, forms, views, workflows, business rules, plugins, web resources, solutions, components, Custom APIs, sitemaps, option sets |
| `d365_layers` | `msdyn_componentlayer`: which solutions have overridden a component, who is on top, and which layer is currently active |

### Snapshots and diff

| Tool | Purpose |
| --- | --- |
| `d365_sync` | Pulls an environment's metadata into a local snapshot, recording "complete / truncated / failed" per resource |
| `d365_diff` | Field-level differences between two snapshots (added, removed, modified), with noise filtering and a stale-snapshot warning |

### Impact and data

| Tool | Purpose |
| --- | --- |
| `d365_refs` | Reverse lookup: field → forms/views/processes; web resource → forms and events; assembly → types and steps |
| `d365_data` | Business records: count / group by / sample (requires `data.read`) |
| `d365_data_write` | Create or update one business record, executed after confirmation in the conversation (requires `data.write`) |

### Writes

| Tool | Purpose |
| --- | --- |
| `d365_write` | Add/update/delete option values, add/update/delete fields, rename a table, add or remove system view columns; `plan-*` only produces a plan, `execute` requires manual confirmation |

### Migration and checks

| Tool | Purpose |
| --- | --- |
| `d365_migrate` | Solution migration risk assessment: layer shadowing, missing components, lost option values, version and managed state |
| `d365_contract` | Contract matrix and drift: assemblies, plugin types, steps, form libraries, handlers, sitemaps, option values; with waivers and trends |
| `d365_code_check` | Reads a GitLab MR, maps JS/C# changes onto the target environment and reports blocker / warning / manual confirmation |

### Operations

| Tool | Purpose |
| --- | --- |
| `d365_reports` | Local artifacts and disk usage, cleanup per retention policy (dry run by default), snapshot compaction |

---

## Settings page

"Settings → D365 Toolkit" in the DSH Web UI, six tabs:

| Tab | Contents |
| --- | --- |
| Environments | Environment inventory, test connection, default environment |
| Permissions | Tick capabilities per environment (read business data / write kinds), default solution for changes, copy to other environments |
| Plans | Pending write plans, recent change records and publish results (re-publishable) |
| Data | File count / size / retention policy per artifact kind, dry run and cleanup, snapshot compaction |
| GitLab | Repository URL, default project, read-only token (`read_api`) |
| General | Snapshots to keep, default row limit, request timeout |

The UI language follows DSH (Chinese / English). The environment inventory and `d365_configure` go through the same storage code, so what the UI shows and what the agent sees always match.

---

## Installation

Prerequisites: DSH desktop; network access to `*.dynamics.com`; a read-only application user (ClientId + secret).

```bash
# From npm (shortest, upgradeable; works once the package is published)
plugin_manager install_bundle target="dsh-d365-kit@0.25.0"

# From Git (no registry needed, pin a tag)
plugin_manager install_bundle target="git+https://<your-git>/<group>/dsh-d365-kit.git#v0.25.0"

# From a local directory (link: code changes take effect immediately)
plugin_manager install_bundle target="D:\path\to\dsh-d365-kit"
```

`dsh-d365-kit@<version>` is resolved from the **npm registry**; a GitHub repository alone is reachable through the `git+https://` form (that is how the second command works today). The repo ships `.github/workflows/publish.yml`, so pushing a `v*` tag publishes to npm once `NPM_TOKEN` is configured.

After installing, **restart DSH once** so the web client loads the settings page code into its module graph.

Then: Settings → D365 Toolkit → Environments → Add environment (key, URL, tenant, ClientId, secret) → Test connection → Save.
Read-only by default; to read business records, tick "Read business data" under "Permissions".

For full steps, credential resolution order, upgrade and uninstall, see [docs/en/installation.md](docs/en/installation.md).

---

## Typical usage

### 1. Assess a solution before deploying

```
What are the risks of shipping this solution to SIT and UAT?

d365_migrate action=assess source=dev solution=ContosoBase targets=["sit","uat"]
```

The report answers: does the target already have this solution, is the source version higher, whose layers will sit on top of each component (listing the shadowed solutions), and will option sets lose values. It lands in `.d365/reports/migration-*.md`.

### 2. Can this field be deleted

```
Who else still uses account.contoso_customertier? Also check how many records carry a value.

d365_refs   kind=field entity=account attribute=contoso_customertier
d365_data   action=group entity=account field=contoso_customertier
```

### 3. Why two environments differ

```
d365_sync environments=["dev","sit"]
d365_diff base=dev head=sit resources=["forms","views","attributes"]
d365_layers component=Account componentType=SystemForm
```

### 4. Check whether an MR can ship to UAT

```
d365_code_check mergeRequest="https://gitlab.example.com/contoso/powerapps/-/merge_requests/7759/diffs" targets=["uat"]
```

JS changes are mapped to web resources and forms, checking whether the fields they read are on the form and whether deleted functions are still referenced by a handler;
C# changes are checked against assembly version, plugin types, steps, step images and filtering attributes. Anything that cannot be decided statically goes into the "manual confirmation" list.

### 5. Add 36 tax ID option values (the full write flow)

```
d365_write action=plan-add-options environment=dev optionSet=contoso_taxcategoryos labels=["AD3|Andorra: Tax Register Number", ...]

(the agent returns the plan and the operation list)
Run mw04aul6-1ci6aa
```

The second step pops a confirmation card in the conversation; nothing is written until you click "Approve and execute". After writing, only the affected option set is published — the whole organization is not recalculated.

### 6. Upstream plugins changed — what is downstream missing

```
d365_contract action=drift source=dev targets=["sit","uat"] forms=true
```

For more phrasings you can copy straight into a conversation, see [examples/prompts.en.md](examples/prompts.en.md) and [docs/en/scenarios.md](docs/en/scenarios.md).

---

## Permission model

By default **read-only**. Capabilities are granted per environment and live in `write.environments` of `d365.config.json`; the settings page renders one block per environment, separated by a rule:

```json
{
  "write": {
    "capabilityVersion": 2,
    "environments": {
      "dev": ["metadata.read", "data.read", "optionValue.add", "attribute.add"],
      "sit": ["metadata.read", "data.read"]
    },
    "solutionUniqueName": "ContosoBase"
  }
}
```

An environment with no entry has never been configured and gets only `metadata.read`; an empty array revokes everything.

| Capability | Operation | Effect |
| --- | --- | --- |
| `metadata.read` | metadata `GET` | Read tables / fields / forms / views / plugins / layers (on by default) |
| `data.read` | business-data `GET` | Read business records; without it the records in tables are unreadable |
| `data.write` | `POST` / `PATCH` | Create or update business records (no delete) |
| `optionValue.add` | `InsertOptionValue` | Add an option value (global or attribute-local) |
| `optionValue.updateLabel` | `UpdateOptionValue` | Change an option label |
| `optionValue.delete` | `DeleteOptionValue` | Permanently delete an option value (high risk) |
| `attribute.add` | `CreateAttribute` | Add a field |
| `attribute.update` | `UpdateAttribute` | Change a field's display name / description / required level |
| `attribute.delete` | `DeleteAttribute` | Permanently delete a field and its data (high risk) |
| `entity.update` | `UpdateEntity` | Change a table's display name and description |
| `view.columns` | `UpdateSavedQuery` | Add or remove system view columns |

Writes take two steps: `plan-*` generates a plan read-only → a human confirms in the conversation (or the settings page) → `execute`. Before execution it checks whether the environment is importing/publishing and refuses if it is busy; every execution is recorded item by item in `.d365/changes/`, plans move through `pending → running → done/failed`, and a re-run does not submit twice.

The decision lives in one place, `lib/client.js`: metadata requests need `metadata.read`, every other `GET` is blocked as business data unless `data.read` is granted, and writes additionally need `data.write`. All of it happens before the token is fetched, so a new tool cannot bypass these gates.

See [docs/en/permissions.md](docs/en/permissions.md) for details.

---

## Local artifacts

```
<workspace>/
  d365.config.json          # environment inventory and tool parameters (can be committed)
  d365.secrets.json         # client secret (plaintext — do not commit)
  .d365/
    snapshots/<env>/<id>/   # metadata snapshots + manifest
    diffs/                  # diff reports
    reports/                # migration, contract, code check, historical trends
    query/                  # query evidence, data write audit
    pending-writes/         # pending plans
    changes/                # executed changes and publish results
    waivers.json            # contract waivers
```

`.d365/` ships its own `.gitignore` (contents `*`). Default retention: snapshots 2 files/30 days, reports 50/90, diff 20/30, query 100/7, changes 200/180; cleanup runs automatically after artifacts are written, and `waivers.json` plus pending plans are never cleaned up.

---

## Documentation

| Document | Contents |
| --- | --- |
| [docs/en/installation.md](docs/en/installation.md) | Installation, first-time setup, credentials, upgrade, uninstall |
| [docs/en/tools.md](docs/en/tools.md) | Parameters, return values and examples for the 16 tools |
| [docs/en/scenarios.md](docs/en/scenarios.md) | Complete walkthroughs for 8 real scenarios |
| [docs/en/permissions.md](docs/en/permissions.md) | Capability table, write flow, pre-flight check, safety boundary |
| [docs/en/checks.md](docs/en/checks.md) | Rules and confidence levels for migration assessment, contract drift and code checks |
| [docs/en/troubleshooting.md](docs/en/troubleshooting.md) | Common error codes and troubleshooting |
| [docs/en/architecture.md](docs/en/architecture.md) | Module layout, data flow, how to add a tool |
| [CHANGELOG.md](CHANGELOG.md) | Version history |

---

## Known limitations

- Does not collect Ribbon or Power Automate cloud flows.
- `attributes` is requested per entity, so with many entities the request count equals the entity count; use `entities` to narrow the scope.
- Metadata tables mostly have no incremental cursor, so every sync is a full pull; a delta is only possible by "running it a second time, then diffing".
- `d365_layers` relies on the `msdyn_componentlayer` virtual table: you must supply both the component id and the type; a name alone returns 0 rows.
- Component types 36 / 50 / 70 (report and chart kinds) have no matching name in the layer table, so only their existence is checked.
- Layer order is determined by **import time**, not version number: whoever imported later is on top.
- `secureconfiguration` always reads back empty through the Web API, so plugin secure config can only be confirmed manually.
- Contract drift reads live data (not snapshots) and takes tens of seconds to a few minutes on a large environment.

---

## Development

```
index.js              # Host entry: registers the 16 tools, mounts the settings page routes
client.js             # settings page (six tabs, no build step)
lib/
  client.js           # Dataverse Web API client (retry, paging, permission gate)
  auth.js             # Entra ID client credentials flow + token cache
  config.js           # config loading and normalization
  resources.js        # query definitions for the 19 metadata resource kinds
  write-actions.js    # planner / executor for all write operations
  contract.js         # contract matrix and drift rules
  migrate.js          # migration assessment
  code-check.js       # MR check (JS)
  csharp-check.js     # MR check (C#)
  refs.js             # reverse index
  retention.js        # retention policy and disk cleanup
  ...
```

Zero runtime dependencies: only Node's built-in `fetch` / `fs` / `path`. After changes, validate each file with `node --check`; host-side changes take effect only after reloading the plugin (`plugin_manager set_plugin enabled=false` then `true`), client code needs a page refresh.

Conventions for a new tool: `parameters` and `output.schema` both use standard JSON Schema; return "summary + file path" and write the body to a file; after registering, add it to the disposers in `index.js`.

---

## Status

An internal tool, evolving with project needs. Version semantics: bug fixes bump patch, new tools/capabilities bump minor, config structure changes bump major.

Environment configuration and secrets are not shipped with the package; each machine fills in `d365.config.json` and `d365.secrets.json` itself.

---

## License

[MIT](LICENSE) © 2026 iTanzhao

Use it, change it, ship it — keep the copyright notice. No warranty, no trademark rights.
