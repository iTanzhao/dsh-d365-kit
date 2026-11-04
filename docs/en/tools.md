# Tool Reference

**English** | [简体中文](../zh/tools.md)

15 tools, all prefixed with `d365_`. Every result is "summary + file path": when the body is too long it goes to a file, and the conversation only gets the conclusion and the location.

Conventions:

- **Environment parameters**: `environment` (single), `environments` (array), `allEnvironments` (all). When omitted, the configured default environment is used.
- **Read vs. write**: only `d365_write execute` and `d365_data_write` change an environment, and each must be approved by a human on a confirmation card.
- **Artifacts**: `<workspace>/.d365/`. File paths are returned and can be opened directly with the file tools.

---

## d365_envs

Lists environments and whether credentials are complete. Call it before answering "does environment X have Y", so "not configured" is never reported as "not in the environment".

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `check` | boolean | false | Actually connect to each environment to verify (consumes a few requests) |

```json
{ "check": true }
```

Returns: each environment's key, display name, URL, credential source (inline / secrets / env), connectivity and version.

---

## d365_configure

Reads and writes the environment list: the same data as "Environments" on the settings page.

| Parameter | Type | Description |
| --- | --- | --- |
| `action` | `list` \| `save` \| `remove` \| `check` | Defaults to `list` |
| `environment` | string | Environment key; required for `save` / `remove` / `check` |
| `url` | string | `save`: environment URL |
| `label` | string | `save`: display name |
| `cloud` | `public` \| `usgovernment` \| `dod` \| `china` | `save`: cloud, default `public` |
| `tenantId` | string | `save`: Entra tenant ID |
| `clientId` | string | `save`: application user ClientId |
| `clientSecret` | string | `save`: client secret, written to `d365.secrets.json` |
| `clearSecret` | boolean | `save`: clear the saved secret |
| `defaultEnvironment` | string | `save`: also set it as the default environment |

```json
{ "action": "save", "environment": "sit", "url": "https://contoso-sit.crm5.dynamics.com",
  "tenantId": "<tenant-guid>", "clientId": "<client-id>", "clientSecret": "<secret>" }
```

Note: the secret is written **in plain text** to a local file. Do not paste it into commit history or screenshots.

---

## d365_metadata

Queries metadata by category. 19 resource types:

`organization`, `entities`, `attributes`, `keys`, `one_to_many_relationships`, `many_to_many_relationships`,
`forms`, `views`, `workflows`, `business_rules`, `plugin_assemblies`, `plugin_types`, `plugin_steps`,
`web_resources`, `solutions`, `solution_components`, `custom_apis`, `sitemaps`, `option_sets`

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `resource` | enum (list above) | Required | Which category to query |
| `entity` | string | — | Entity logical name, used by attributes / keys / relationships / forms / views / workflows etc. |
| `filter` | string | — | Extra OData `$filter`, without `$filter=`, e.g. `contains(name,'Approval')` |
| `select` | string | — | Extra columns to return, comma-separated; an invalid column name falls back and retries automatically |
| `orderby` | string | — | Overrides the default sort, e.g. `modifiedon desc` |
| `top` | integer | configured `maxRecords` (200) | Maximum rows to return |
| `environments` | string[] | default environment | Query several environments at once, align them by name, and report cross-environment differences |
| `allEnvironments` | boolean | false | All environments |
| `save` | boolean | false | Force the full result into a file (by default it is written only when over 12 rows) |

```json
{ "resource": "attributes", "entity": "account", "filter": "startswith(logicalname,'contoso_')", "top": 20 }
```

A few real constraints:

- The metadata endpoints (`EntityDefinitions`) **do not accept** `$orderby` and `$top`; the client falls back and retries step by step;
- Display names are multilingual, so compare across environments by **logical name**, not display name;
- Entity set names can be customized; do not hard-code the plural form — use the `entities` resource or `d365_data`'s automatic resolution.

---

## d365_layers

Queries `msdyn_componentlayer`: which solutions have overridden a component, the layer order, and which one takes effect.

`msdyn_componentlayer` is a virtual entity (custom data provider): **the component id and the component type must both be supplied**. Supplying only a name, only an id, or nothing at all returns 0 rows (with no error).

| Parameter | Type | Description |
| --- | --- | --- |
| `component` | string | Component name or GUID. Entities use the logical name; other types use the name / unique name of that record type |
| `componentType` | enum | `Entity`, `Attribute`, `SystemForm`, `SavedQuery`, `Workflow`, `WebResource`, `PluginAssembly`, `PluginType`, `SdkMessageProcessingStep`, `CustomAPI` |
| `entity` | string | Required when `componentType=Attribute` |
| `solution` | string | Look only at one solution's layers (filtered within the results) |
| `includeJson` | boolean | Also fetch `msdyn_componentjson` (full definition, potentially large, written to a file) |
| `top` | integer | Maximum records to fetch, default 500 |
| `environments` / `allEnvironments` | | Compare the active layer across environments |

```json
{ "component": "account", "componentType": "Entity", "allEnvironments": true }
{ "componentType": "Attribute", "component": "name", "entity": "account" }
{ "componentType": "SystemForm", "component": "Account" }
```

Rows are returned in ascending `msdyn_order`; the last layer is the one currently in effect; `(system layer)` means the layer does not come from any solution.

Known limitation: in some environments the table is readable but returns 0 rows; administrator identity is required to see the data.

---

## d365_sync

Pulls environment metadata into a local snapshot.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `environments` | string[] | default environment | Environments to sync |
| `allEnvironments` | boolean | false | All environments |
| `resources` | enum[] | a set of core resources (without attributes) | Sync only the specified resources |
| `includeAttributes` | boolean | false | Also pull each entity's attribute definitions (requests ≈ number of entities) |
| `entities` | string[] | — | With `includeAttributes`, pull only these entities |
| `maxRecords` | integer | 0 = full | Maximum rows per resource; truncation is flagged in the manifest |
| `keep` | integer | configured `snapshotKeep` (2) | How many snapshots to keep per environment; the oldest are deleted |

```json
{ "environments": ["dev", "sit"], "includeAttributes": true,
  "entities": ["account", "contact", "contoso_order"] }
```

Artifact `<workspace>/.d365/snapshots/<env>/<snapshot-id>/`:

```
manifest.json     # coverage: count / truncated / error per resource
entities.json
solutions.json
attributes.json   # only with includeAttributes
...
```

The manifest is the only basis for telling "not in the environment" apart from "not collected". A full snapshot is roughly 125 MB and takes about three minutes; by default 2 are kept per environment.

After a sync, retention-policy cleanup runs automatically and snapshots are compacted into single-line JSON.

---

## d365_diff

Field-level differences between two snapshots.

| Parameter | Type | Description |
| --- | --- | --- |
| `base` | string | Base snapshot: `dev` (latest), `dev@prev` (previous), `dev@20261102T071005Z` (specific) |
| `head` | string | Comparison snapshot, same notation |
| `resources` | string[] | Compare only these resources |
| `maxDetails` | integer | Maximum entries listed per resource in the reply, default 30; the full list goes to the report |

```json
{ "base": "dev", "head": "sit", "resources": ["forms", "views", "attributes"] }
```

Time suffixes can be shortened: `sit@082604` matches `20261102T082604Z`.

Noise control: timestamps and all `*id` columns are ignored (`NOISE_FIELDS`), and `organization` (environment identity) is skipped by default. Reports go to `.d365/diffs/`; if a snapshot is more than 24 hours old, the report suggests re-syncing first.

---

## d365_refs

Reverse lookup of references: "who uses the thing I am about to change or delete".

| Parameter | Type | Description |
| --- | --- | --- |
| `kind` | `field` \| `web_resource` \| `plugin_assembly` | Required |
| `entity` | string | Required for `kind=field` |
| `attribute` | string | Required for `kind=field` |
| `name` | string | For `kind=web_resource`, the resource name; for `kind=plugin_assembly`, the assembly name |
| `environment` / `environments` / `allEnvironments` | | Can span environments |

```json
{ "kind": "field", "entity": "account", "attribute": "contoso_customertier", "environments": ["dev", "sit"] }
{ "kind": "web_resource", "name": "contoso_/scripts/account_form.js" }
{ "kind": "plugin_assembly", "name": "Contoso.Customizations" }
```

| kind | Returns |
| --- | --- |
| `field` | Which forms carry the field (hidden ones flagged separately), which views use it in columns / filters, and which workflows and business rules reference it |
| `web_resource` | Which forms load this library, and which events and handlers are bound |
| `plugin_assembly` | Version, number of registered types, and the steps of each type (message, entity, stage, filtering attributes, rank) |

The implementation is server-side `contains()` filtering (`formxml` / `layoutxml` / `fetchxml`), so the whole organization is never pulled locally. Full results are in `.d365/query/`.

Limitations: a quick view of forms that reference fields of other entities is out of scope; workflows / business rules are text matches, so dynamically assembled field names can be missed.

---

## d365_data

Reads business records. **Off by default**: unless "Read business data" (`data.read`) is checked for that environment on the settings page, any non-metadata table is rejected before a token is acquired.

| Parameter | Type | Description |
| --- | --- | --- |
| `action` | `count` \| `group` \| `sample` | Required |
| `entity` | string | Required. Logical name or set name (`contoso_systemconfiguration` / `contoso_systemconfigurations`) |
| `filter` | string | OData `$filter`, without `$filter=` |
| `field` | string | Required for `group`: which column to group by |
| `select` | string | Columns returned by `sample`, comma-separated |
| `top` | integer | `sample` row count (default 5, max 100); `group` returns the first N groups (default 20) |
| `environment` / `environments` / `allEnvironments` | | Environment selection |

```json
{ "action": "count", "entity": "contoso_systemconfiguration", "filter": "statecode eq 0" }
{ "action": "group", "entity": "account", "field": "contoso_customertier" }
{ "action": "sample", "entity": "account", "select": "name,contoso_customertier", "top": 5 }
```

Counting prefers `$apply=aggregate($count as count)` (unaffected by the 5,000 cap of `$count=true`), falling back to `$count=true`; empty groups display as "(empty)".

Use it to learn "how many records still use this value" before changing an option set, deleting a field, or narrowing a filter.

---

## d365_data_write

Creates or updates **one** business record, for scenarios such as seeding configuration data.

| Parameter | Type | Description |
| --- | --- | --- |
| `action` | `create` \| `update` | Required |
| `entity` | string | Required, logical name or set name |
| `id` | string | Required for `update`: primary key GUID |
| `values` | object | Required: field logical name → value; `null` clears the value |
| `environment` | string | Single environment; it never writes across environments in bulk |

```json
{ "action": "create", "entity": "contoso_systemconfiguration",
  "values": { "contoso_key": "FEATURE_X", "contoso_value": "1" } }
```

Constraints:

- Requires `data.write` authorization on that environment (off by default);
- Every write shows a confirmation card (environment, table, field names and values; values truncated to 120 characters, at most 20 fields);
- `create` sends `Prefer: return=representation`, `update` sends `If-Match: *`;
- Audit is written to `.d365/query/<timestamp>-data-write-<action>.json`, recording **field names only, never values**;
- Records cannot be deleted.

---

## d365_write

Metadata changes. **`plan-*` actions are read-only** and only produce a plan; `execute` writes only after a confirmation card is approved in the conversation.

| `action` | Required parameters | Effect |
| --- | --- | --- |
| `policy` | — | Show the capabilities authorized for each environment |
| `plan-add-options` | `optionSet` or `entity`+`attribute`, `labels` | Add option values; codes are deduplicated by the part before `\|`, and values continue from the current maximum +1 |
| `plan-relabel` | `optionSet` or `entity`+`attribute`, `updates` | Relabel option values |
| `plan-option-delete` | same as above, `values`, `acknowledge: true` | Delete option values (high risk) |
| `plan-add-attribute` | `entity`, `schemaName` | Add a field; types below |
| `plan-update-attribute` | `entity`, `attribute`, the items to change | Change display name / description / required level |
| `plan-delete-attribute` | `entity`, `attribute`, `acknowledge: true` | Delete a field (high risk) |
| `plan-update-entity` | `entity`, `displayName` | Change the table display name and description |
| `plan-view-columns` | `view`, `addColumns` / `removeColumns` | Add or remove system view columns |
| `list` | — | List pending plans |
| `execute` | `planId` | Show a confirmation card and run after approval |
| `cancel` | `planId` | Cancel a pending plan |

Common parameters:

| Parameter | Description |
| --- | --- |
| `environment` | Target environment key |
| `solutionUniqueName` | Unique name of the **unmanaged** solution that carries the change; omitted, the settings page default is used. A name that does not exist or is managed fails immediately |
| `rationale` | Reason for the change, written into the plan and the change record |
| `force` | `execute`: skip the "environment is publishing / importing" check; use only when that record is confirmed to be stale |

`plan-add-attribute` types and parameters:

| `fieldType` | Extra parameters | Default |
| --- | --- | --- |
| `string` | `maxLength` | 100 |
| `memo` | `maxLength` | 2000 |
| `integer` | — | — |
| `decimal` | `precision` | 2 |
| `money` | `precision` | 2 |
| `boolean` | — | True/False labels |
| `datetime` | — | Date + time |

`requiredLevel`: `None` / `Recommended` / `Required`; `language` defaults to 1033 (use 2052 for Chinese environments).

```json
{ "action": "plan-add-options", "environment": "dev", "optionSet": "contoso_taxcategoryos",
  "labels": ["AD3|Andorra: Tax Register Number (NRT)", "AE1|UAE: TRN"] }
```

```json
{ "action": "plan-add-attribute", "environment": "dev", "entity": "account",
  "schemaName": "contoso_CustomerTier", "fieldType": "string", "maxLength": 120,
  "displayName": "Customer Tier", "requiredLevel": "None" }
```

```json
{ "action": "execute", "planId": "mw04aul6-1ci6aa" }
```

Write details, confirmation cards and publish scope are covered in [permissions.md](permissions.md).

---

## d365_migrate

Assesses the migration risk of publishing a solution to other environments.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `action` | `assess` | `assess` | Assessment only, for now |
| `source` | string | default environment | Source environment |
| `solution` | string | Required | Solution unique name |
| `targets` | string[] | all except source | Target environments |
| `maxComponents` | integer | 150 | Maximum components to assess |
| `full` | boolean | false | Assess all components (ignores `maxComponents`) |
| `concurrency` | integer | 4, max 8 | Number of concurrent requests |

```json
{ "action": "assess", "source": "dev", "solution": "ContosoBase", "targets": ["sit"] }
```

Results fall into three categories: data risk (option values lost, labels drifted), masking (who sits on top of the target layer, which solutions get covered after import), and missing components and version differences.

Report: `.d365/reports/migration-<solution>-to-<target>-<timestamp>.md` + `.json`. Rule details are in [checks.md](checks.md).

---

## d365_contract

Contract matrix and drift: treats upstream plugin registrations and form references as a contract and checks whether downstream still honors it.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `action` | `drift` \| `matrix` \| `waive` \| `waivers` | `drift` | |
| `source` | string | default environment | Upstream |
| `targets` | string[] | all except upstream | Downstream |
| `optionSets` | string[] | — | Global option sets to compare value by value |
| `includeManaged` | boolean | false | Include managed assemblies in the comparison (noisy) |
| `forms` | boolean | true | Check the web resources and sitemap referenced by forms |
| `handlers` | boolean | false | Download scripts to verify Handler functions exist (slow) |
| `rule` / `env` / `object` / `reason` / `days` | | | For `waive`: rule, environment, object, reason, expiry days (default 30) |

```json
{ "action": "drift", "source": "dev", "targets": ["sit", "uat"], "forms": false }
```

```json
{ "action": "waive", "rule": "form-library-missing", "env": "sit",
  "object": "/_static/_common/scripts/CommandbarActions.js", "reason": "this environment does not use the SLA dialog", "days": 30 }
```

The rule table, waivers and trends are in [checks.md](checks.md). Reports are in `.d365/reports/contract-*.md|json`.

---

## d365_health

Environment health: "is it safe to touch this environment right now".

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `environments` | string[] | default environment | |
| `allEnvironments` | boolean | false | |
| `hours` | integer | 24 | Lookback hours for failed jobs |

```json
{ "allEnvironments": true, "hours": 24 }
```

Per environment it reports: version, organization name, number of suspended jobs, recent failure count (merged by job name), solutions currently importing / publishing, and recently installed solutions.
The same "importing / publishing" determination is reused by the pre-write check.

---

## d365_reports

Local artifacts and disk usage.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `action` | `list` \| `cleanup` \| `compact` | `list` | |
| `target` | `snapshots` \| `reports` \| `diffs` \| `query` \| `changes` \| `all` | `all` | Scope for `cleanup` |
| `dryRun` | boolean | **true** | Dry run only; pass `false` after confirming to actually delete |
| `limit` | integer | 15 | How many entries `list` shows per category |

```json
{ "action": "cleanup", "target": "query" }
{ "action": "cleanup", "target": "query", "dryRun": false }
{ "action": "compact" }
```

Cleanup touches only known subdirectories under `.d365/`, verifying each path prefix before deleting; `waivers.json`, `pending-writes/` and configuration files are never deleted.

---

## d365_code_check

Reads a GitLab MR once and checks whether the changes will fail to run in the target environment.

| Parameter | Type | Description |
| --- | --- | --- |
| `mergeRequest` | string | Required. MR link or IID (`42` / `!42`) |
| `project` | string | `group/project`; if omitted, the project from the link is used, and if that is also omitted, the settings page default project |
| `targets` | string[] | Environments to check against; all if omitted |

```json
{ "mergeRequest": "https://gitlab.example.com/contoso/powerapps/-/merge_requests/7759/diffs",
  "targets": ["uat"] }
```

You must first fill in the URL and a read-only token (`read_api`) under "GitLab" on the settings page; the token's user needs at least the Reporter role.

The output has three parts: blockers, warnings, manual confirmation. Reports are in `.d365/reports/code-check-<MR>-<timestamp>.md`. Rule details are in [checks.md](checks.md).
