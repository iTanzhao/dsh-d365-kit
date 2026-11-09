# Tool Reference

**English** | [简体中文](../zh/tools.md)

18 tools, all prefixed with `d365_`. Every result is "summary + file path": when the body is too long it goes to a file, and the conversation only gets the conclusion and the location.

Conventions:

- **Environment parameters**: `environment` (single), `environments` (array), `allEnvironments` (all). When omitted, the configured default environment is used.
- **Read vs. write**: only `d365_write execute`, `d365_data_write` and `d365_data_sync execute` change an environment, and each must be approved by a human on a confirmation card.
- **Artifacts**: `<workspace>/.d365/`. Paths are returned as **absolute paths** and can be opened directly with the file tools.

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

Queries metadata by category. 20 resource types:

`organization`, `entities`, `attributes`, `keys`, `one_to_many_relationships`, `many_to_many_relationships`,
`forms`, `views`, `workflows`, `business_rules`, `plugin_assemblies`, `plugin_types`, `plugin_steps`, `step_images`,
`web_resources`, `solutions`, `solution_components`, `custom_apis`, `sitemaps`, `option_sets`

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `resource` | enum (list above) | Required | Which category to query |
| `entity` | string | — | Entity logical name, used by attributes / keys / relationships / forms / views / workflows etc. |
| `name` | string | — | Fetch one record by exact name (currently `option_sets` only: a keyed read, one request for one global option set instead of pulling all 900+ definitions) |
| `attribute` | string | — | For `attributes`: read one column (keyed read). Pair with `cast` for columns that only exist on a derived type |
| `cast` | string | — | Cast the attribute to its derived metadata type, e.g. `BooleanAttributeMetadata`, `PicklistAttributeMetadata`, `LookupAttributeMetadata`, `StringAttributeMetadata`. Only with `attribute` |
| `expand` | string | — | Extra `$expand`, e.g. `plugintypeid($select=typename)`; `plugin_steps` already expands the plug-in type and message |
| `filter` | string | — | Extra OData `$filter`, without `$filter=`, e.g. `contains(name,'Approval')` |
| `select` | string | — | Extra columns to return, comma-separated; an invalid column name falls back and retries automatically. **An explicit `select` also decides which columns the inline table shows** |
| `orderby` | string | — | Overrides the default sort, e.g. `modifiedon desc` |
| `top` | integer | 1000 for list resources, otherwise configured `maxRecords` (200) | Maximum rows to return |
| `environments` | string[] | default environment | Query several environments at once, align them by name, and report cross-environment differences |
| `allEnvironments` | boolean | false | All environments |
| `save` | boolean | false | Force the full result into a file (by default it is written only when over 12 rows) |

```json
{ "resource": "attributes", "entity": "account", "filter": "startswith(logicalname,'contoso_')", "top": 20 }
```

A few real constraints:

- The metadata endpoints (`EntityDefinitions`) **do not accept** `$orderby` and `$top`; the client falls back and retries step by step;
- Display names are multilingual, so compare across environments by **logical name**, not display name;
- Entity set names can be customized; do not hard-code the plural form — use the `entities` resource or `d365_data`'s automatic resolution;
- `workflows` / `business_rules` return the **definition row only** by default (`type eq 1`): Dataverse stores a second, same-named activation row (`type eq 2`, different `workflowid`) for every process, which otherwise looks like a duplicate and doubles the count. An explicit `filter` (e.g. `type eq 2`) replaces the default instead of ANDing with it, so it never collapses to an empty result.
- `option_sets` (`GlobalOptionSetDefinitions`) **do not accept** `$filter` (the service answers HTTP 405: `The query parameter $filter is not supported`), so `filter` is rejected up front with a hint to use `name` instead. A lookup by name is a keyed read; when nothing matches it returns 404, and the tool reports "this environment has no global option set named X" rather than an empty table.
- To see all 987 definitions at once, or to read the option values: query without `filter`/`name`, or use the cast path (`GlobalOptionSetDefinitions(<id>)/Microsoft.Dynamics.CRM.OptionSetMetadata?$select=Options`), which the tool does not wrap yet.
- List resources (`plugin_steps`, `plugin_types`, `step_images`, `attributes`) default to 1000 rows, not 200: a mature organization often has 5000+ `sdkmessageprocessingsteps`, and 200 rows sorted by name makes the step you want look absent. When a result is truncated the digest says "N shown / M total" (`M` from the server's `$count`, which itself caps at 5000 and is shown as ≥5000) — truncation is never silent.
- Columns that only live on a derived type must be cast: `DefaultValue`, `OptionSet`, `Targets`, `Format` are not on the `AttributeMetadata` base type. Read one field with `{"resource":"attributes","entity":"account","attribute":"donotemail","cast":"BooleanAttributeMetadata","select":"LogicalName,DefaultValue"}`; selecting those columns without a cast returns 400.
- `plugin_steps` expands `plugintypeid($select=typename),sdkmessageid($select=name)` by default — that is where the `plugintype` / `message` columns come from (a step's `name` is often blank, so those two are how you recognise it). Step images live in the `step_images` resource.

---

## d365_layers

Queries `msdyn_componentlayer`: which solutions have overridden a component, the layer order, and which one takes effect.

`msdyn_componentlayer` is a virtual entity (custom data provider): **the component id and the component type must both be supplied**. Supplying only a name, only an id, or nothing at all returns 0 rows (with no error).

| Parameter | Type | Description |
| --- | --- | --- |
| `component` | string | Component name or GUID. Entities use the logical name; other types use the name / unique name of that record type; `OptionSet` uses the global option set name |
| `componentType` | enum | `Entity`, `Attribute`, `SystemForm`, `SavedQuery`, `Workflow`, `WebResource`, `PluginAssembly`, `PluginType`, `SdkMessageProcessingStep`, `CustomAPI`, `OptionSet` |
| `entity` | string | Required when `componentType=Attribute` |
| `solution` | string | Look only at one solution's layers (filtered server-side, so a component with more layers than `top` cannot read as "no layer") |
| `includeJson` | boolean | Also fetch `msdyn_componentjson` (full definition, potentially large, written to a file) |
| `top` | integer | Maximum records to fetch, default 500 |
| `environments` / `allEnvironments` | | Compare the active layer across environments |

```json
{ "component": "account", "componentType": "Entity", "allEnvironments": true }
{ "componentType": "Attribute", "component": "name", "entity": "account" }
{ "componentType": "SystemForm", "component": "Account" }
{ "componentType": "OptionSet", "component": "contoso_taxcategoryos", "allEnvironments": true }
```

Rows are returned in ascending `msdyn_order`; the last layer is the one currently in effect; `(system layer)` means the layer does not come from any solution.

`Active` is the pseudo solution name Dataverse uses for an **unmanaged customization layer**: when present it always sits on top, covering the managed layers below, and it is the only layer `d365_write plan-remove-layer` can delete. The output therefore labels it `Active (unmanaged)` and states explicitly whether the top layer is unmanaged or whether "this environment has no unmanaged layer" — the latter means the component is fully driven by solutions here. An Active layer's `msdyn_overwritetime` is always `1900-01-01` (the service does not record it), so the timestamp is shown as "not recorded" instead of a fake date.

`OptionSet` resolves **global** option sets only (via `GlobalOptionSetDefinitions(Name='…')` to get the `MetadataId`); local option sets live with their column, so use `componentType=Attribute` plus `entity` to inspect a column's layers. Their layer can be removed too (`d365_write plan-remove-layer` with `componentType: OptionSet`).

In a multi-environment query, an environment that lacks the component (name not found) only reports "this environment does not have this component"; the other environments still return their layers and take part in the comparison. The call only fails when every environment lacks it.

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

`attributes`, `keys`, `one_to_many_relationships` and `many_to_many_relationships` are per-entity: without `entities` they are skipped and listed under "issues" (they used to build `LogicalName='undefined'` and fail).

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

`solution_components` is the exception: a component's `objectid` is a GUID minted per organization, so aligning rows across environments reports every component as both added and removed. That resource is compared by **counting** rows per `componenttype` instead (`~ componenttype 1: count 11469→10754`), which the report states. To find a specific component, use `d365_migrate` or `d365_layers`.

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

Reads business records. **Off by default**: unless "Read business data" (`data.read`) is checked for that environment on the settings page, any non-metadata table is rejected before a token is acquired. Metadata itself is governed by "Read metadata" (`metadata.read`), on by default.

| Parameter | Type | Description |
| --- | --- | --- |
| `action` | `count` \| `group` \| `sample` \| `query` | Required |
| `entity` | string | Required. Logical name or set name (`contoso_systemconfiguration` / `contoso_systemconfigurations`) |
| `filter` | string | OData `$filter`, without `$filter=` |
| `field` | string | Required for `group`: which column to group by |
| `select` | string | Columns returned by `sample` / `query`, comma-separated; `query` without it returns whatever columns the rows carry |
| `orderby` | string | `query` sort, e.g. `modifiedon desc` |
| `expand` | string | `query` `$expand`, e.g. `primarycontactid($select=fullname)` |
| `id` | string | `query`: one record by primary key (GUID, or a quoted alternate key such as `'contoso_001'`) |
| `top` | integer | `sample` rows (default 5, max 100); `group` first N groups (default 20); `query` rows (default 25, max 500) |
| `environment` / `environments` / `allEnvironments` | | Environment selection |

```json
{ "action": "count", "entity": "contoso_systemconfiguration", "filter": "statecode eq 0" }
{ "action": "group", "entity": "account", "field": "contoso_customertier" }
{ "action": "sample", "entity": "account", "select": "name,contoso_customertier", "top": 5 }
{ "action": "query", "entity": "account", "select": "name,createdon", "orderby": "createdon desc", "top": 3 }
{ "action": "query", "entity": "accounts", "id": "11111111-1111-1111-1111-111111111111" }
```

Counting prefers `$apply=aggregate($count as count)` (unaffected by the 5,000 cap of `$count=true`), falling back to `$count=true`; empty groups display as "(empty)".

`query` distinguishes three outcomes in its heading: `共 N 行` (all N rows), `已列 N 条 / 共 M 条` (N of M shown), or `返回 N 行（可能还有更多）` (there may be more). **A GUID copied from another environment is a 404 when it is absent here**, and the `id` path reports `record-not-found` instead of handing back an empty table.

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

## d365_data_sync

Moves business records from one environment to another. The default is **mirror** (source GUID becomes target GUID): `plan` is a read-only dry run that reports volume, fields, lookup outcomes, conflicts, **whether the permissions to execute are granted**, and whether plugins are bypassed — then it lists three things for you to confirm: scope, fields, and bypass. `execute` writes only after a human approves the card.

| `action` | What it does |
| --- | --- |
| `plan` | Builds a read-only plan and writes it to a file; nothing touches either org (default) |
| `plan-update` | Builds a read-only **bulk update** plan (one environment, an explicit id list) |
| `show` / `list` / `cancel` | Re-read / list / drop a pending plan |
| `execute` | Shows a confirmation card, then writes |

Three decisions are made before anything moves (the dry run lists all three; change one and re-run `plan`):

1. **Scope**: `since` (a time window; `mode=new` uses createdon, `mode=modified` uses modifiedon), `filter` (OData `$filter`), `ids`, or `fetchXml`. With none of them the whole table is the default; when that is large the plan says so and recommends narrowing it, and `maxRecords` caps how many rows this plan reads.
2. **Fields**: `fields` omitted means every writable column. A field list that **includes the primary key** (`xxxid`) keeps GUIDs identical; a list **without** it lets the target assign new ids. `keepGuid` can still override either way.
3. **Bypass custom plugins**: on by default (`bypassPlugins: true` sends `MSCRM.BypassCustomPluginExecution`, so the target's synchronous plugins do not fire and cannot kick off downstream notifications/integrations). Pass `bypassPlugins: false` to let them run.

```json
{ "action": "plan", "source": "dev", "target": "sit",
  "entity": "account", "since": "2026-11-05T00:00:00+08:00", "maxRecords": 200 }
```

Behavior and constraints:

- **GUIDs**: follow the field list (above). With `keepGuid: false` the target assigns ids, references inside the batch are remapped in dependency order, and a second `PATCH` pass fills in lookups that pointed at a record created later in the run.
- **Lookup resolution order**: same GUID in the target first; otherwise an exact primary-name match (one hit = matched by name, several = ambiguous, none = missing). Polymorphic lookups (such as `customerid`) are resolved to a real table by reading the source first, not by guessing.
- **Lookups are written by navigation property name**: the `@odata.bind` key is the relationship's navigation property, which is not always the attribute's logical name (a custom relationship can keep `contoso_approverid` as the column while binding through `contoso_ApproverId`). The plan reads that map from `RelationshipDefinitions` and lists any field where the two differ; if the map cannot be read it falls back to the logical name and says so under "notes". Plans written by older versions carry no map and `execute` rejects them with `stale-plan` — run `plan` again.
- **Conflicts**: a record whose GUID already exists in the target is reported, not written; `conflict: "overwrite"` turns those into per-row `PATCH`es.
- **Missing references**: by default those rows are skipped and listed; `onMissingLookup: "null"` clears the reference, `"fail"` refuses the whole plan.
- **Write options**: `overriddencreatedon` preserves creation time; `MSCRM.SuppressDuplicateDetection` is sent by default; bypass is on by default and the card states it.
- **Permissions**: `plan` needs `data.read` on both ends; `execute` also needs `data.write` on the target. The plan's "permissions" block names the missing switch — without `data.write` on the target, `execute` is refused, so tick it on the settings page first.
- **Files**: plans under `.d365/data-sync/plans`, run logs under `.d365/data-sync/runs` (source GUID → target GUID and failure reasons per row).
- Creates and updates only, **never deletes**; audit columns (createdby/modifiedby and friends) are not copied; owner follows `ownerMode` (`map` / `keep` / `caller`).

### Bulk updates (`plan-update`, one environment)

Change many existing records inside one environment — no cross-environment copy. Same two-step shape: `plan-update` is a read-only dry run, `execute` asks on a card.

```json
{ "action": "plan-update", "environment": "dev", "entity": "account",
  "ids": ["22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333"],
  "values": { "donotemail": true }, "rationale": "stop emailing these test accounts" }
```

| Parameter | Meaning |
| --- | --- |
| `environment` | Which environment to change (required; a bulk update touches exactly one) |
| `ids` | Primary keys to change, **given explicitly** (deduplicated, at most 1000) |
| `values` | Attribute logical name → new value; scalar columns only |

Behavior and constraints:

- **`filter` / `fetchXml` are refused**: changing a whole batch by query has no undo key. Resolve ids with `d365_data action=query` first, then pass them in.
- **Scalar columns only**: lookups need binding by navigation property name, so `d365_data_write` is the reliable path for a single record; a lookup in `values` is rejected with `lookup-unsupported`.
- The plan reads the current values and previews **before → after** (first five rows), lists ids that do not exist, the write options (bypass / duplicate detection / concurrency), and asks you to confirm scope, fields and bypass.
- **Permissions**: `plan-update` needs `data.read` on that environment (it has to read the current values); `execute` also needs `data.write` plus a human approval on the card.
- Run logs land in `.d365/data-sync/runs` (per-id outcome and failure reason); once again it updates only, **never deletes**.

---

## d365_write

Metadata changes. **`plan-*` actions are read-only** and only produce a plan; `execute` writes only after a confirmation card is approved in the conversation.

| `action` | Required parameters | Effect |
| --- | --- | --- |
| `policy` | — | Show the capabilities authorized for each environment |
| `plan-add-options` | `optionSet` or `entity`+`attribute`, `labels` | Add option values; codes are deduplicated by the part before `\|`, and values continue from the current maximum +1. The label language is `language` (default 1033) |
| `plan-relabel` | `optionSet` or `entity`+`attribute`, `updates` | Relabel option values. Only the `language` entry changes; `MSCRM.MergeLabels: true` keeps the other languages' labels |
| `plan-option-delete` | same as above, `values`, `acknowledge: true` | Delete option values (high risk) |
| `plan-add-attribute` | `entity`, `schemaName` | Add a field; types below |
| `plan-update-attribute` | `entity`, `attribute`, the items to change | Change display name / description / required level |
| `plan-delete-attribute` | `entity`, `attribute`, `acknowledge: true` | Delete a field (high risk) |
| `plan-update-entity` | `entity`, `displayName` | Change the table display name and description |
| `plan-view-columns` | `view`, `addColumns` / `removeColumns` | Add or remove system view columns |
| `plan-remove-layer` | `component`, `componentType` (11 types, see the end of this section), `acknowledge: true` | Remove the top-most unmanaged layer of a component (high risk) |
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

`plan-remove-layer` removes **only the top layer, and only when it reads `Active`** (the unmanaged customizations layer); whatever solution layer sits below becomes active again. It covers every component type `d365_layers` knows:

| `componentType` | `component` holds | Published after removal |
| --- | --- | --- |
| `Entity` (default) | table logical name | that table |
| `Attribute` | column logical name (with `entity`) | that table |
| `OptionSet` | global option set name | that option set |
| `SystemForm` | form name | the form's table (nothing when the form belongs to no table) |
| `SavedQuery` | view name | the view's table |
| `Workflow` | process name | everything |
| `WebResource` | web resource name | everything |
| `PluginAssembly` | assembly name | everything |
| `PluginType` | type full name | everything |
| `SdkMessageProcessingStep` | step name | everything |
| `CustomAPI` | unique name | everything |

| Parameter | Meaning |
| --- | --- |
| `componentType` | see the table above, defaults to `Entity` |
| `component` | see the table above |
| `entity` | Required when `componentType: Attribute`: the table owning that column |

The plan lists the layer stack, the layer being removed, and what becomes active next (or "system definition" when nothing is below). If the top layer is not `Active` the plan is refused: that layer belongs to a solution — remove the component from that solution, or ship a patch that overrides it. Removing a layer cannot be undone; the scope above is published afterwards — a single table only when its ownership is known, otherwise a full publish (slower, but nothing is missed).

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

Per environment it reports: version, organization name, queued (Ready) jobs, suspended jobs, recent failure count (merged by job name), solutions currently importing / publishing, recently installed solutions, and the **plug-in trace level** (organization `plugintracelogsetting`: off / exception only / all).

Failures are `statecode 3` (Completed) **and** `statuscode 31` (Failed): the same Completed state also covers 30 Succeeded and 32 Canceled, so matching on `statecode` alone counts and lists succeeded jobs as failures.

The same "importing / publishing" determination is reused by the pre-write check.

Missing job data never reads as zero: if an environment has not granted "Read business data", the queued / suspended / failed columns show `—` and the table states why. It used to be swallowed into "0 failures", which is a false all-clear exactly when you are investigating.

---

## d365_reports

Local artifacts and disk usage.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `action` | `list` \| `view` \| `cleanup` \| `compact` | `list` | |
| `file` | string | — | For `view`: a path under `.d365` (`query/xxx.json`) or a bare file name |
| `offset` | integer | 0 | For `view`: first line to show (0-based) |
| `match` | string | — | For `view`: only lines containing this string (case-insensitive) — the practical way to find one GUID in a big JSON |
| `wrap` | integer | 400 | For `view`: wrap lines longer than this; 0 means no wrapping |
| `pretty` | boolean | true for `.json` | For `view`: expand JSON with indentation |
| `target` | `snapshots` \| `reports` \| `diffs` \| `query` \| `changes` \| `all` | `all` | Scope for `cleanup` |
| `dryRun` | boolean | **true** | Dry run only; pass `false` after confirming to actually delete |
| `limit` | integer | 15 / 60 | Entries `list` shows per category; for `view`, lines to show (max 2000) |

```json
{ "action": "cleanup", "target": "query" }
{ "action": "cleanup", "target": "query", "dryRun": false }
{ "action": "compact" }
{ "action": "view", "file": "query/2026-11-09T04-03-33-467Z-data-count.json" }
{ "action": "view", "file": "query/layers-uat.json", "match": "contoso_taxcategoryos", "offset": 40 }
```

`view` reads only files under `.d365`: an absolute path pointing elsewhere is refused instead of quietly read.

Cleanup touches only known subdirectories under `.d365/`, verifying each path prefix before deleting; `waivers.json`, `pending-writes/` and configuration files are never deleted.

`reports` counts **reports**, not files: each analysis writes a `.json` + `.md` pair, so counting files made "keep 20" retain ten reports.

---

## d365_invoke

Calls one Dataverse message (action or function) and returns the HTTP status and response body — to reproduce a failure, or to see what a message actually returns.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `message` | string | — | Required. Message name, e.g. `WinOpportunity`, `contoso_DoSomething` |
| `method` | `POST` \| `GET` | `POST` | `POST`=action (may carry a body); `GET`=function (parameters go into the URL as OData aliases, cannot bind a record) |
| `entity` | string | — | Required for a bound action: the record's entity set (`accounts`) |
| `id` | string | — | Required for a bound action: the record's primary key GUID |
| `parameters` | object | — | `POST`: the request body (action inputs); `GET`: named function parameters (values are formatted as OData literals) |
| `environment` | string | default environment | |
| `rationale` | string | — | Why this message is being called; written to the artifact and the run record |

```json
{ "message": "RetrieveTotalRecordCount", "method": "GET", "parameters": { "EntityNames": ["account"] } }
{ "message": "WinOpportunity", "entity": "opportunities", "id": "<guid>", "parameters": { "Status": 3 } }
```

**The capability follows the method**: a `GET` function is a read and needs "Read business data" (`data.read`); a `POST` action needs "Call messages" (`message.invoke`, off by default). Every POST asks for confirmation in the chat with the environment, path and body. **A failed call does not throw** — it returns the HTTP status, Dataverse error code and response body verbatim, which is exactly the part you need when reproducing a problem.

---

## d365_trace

Reads plug-in trace logs: who ran, for how long, and why it threw.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `action` | `list` \| `get` \| `summary` | `list` | |
| `traceId` | string | — | Required for `get`: the `plugintracelogid` (usually from `list`) |
| `hours` | number | 24 | Look-back window in hours |
| `entity` | string | — | Only traces on one table (`primaryentity`, e.g. `account`) |
| `typename` | string | — | Only one plug-in type; contains is supported, e.g. `ContactSearch` |
| `message` | string | — | Only one message (`messagename`, e.g. `Create`) |
| `exceptionOnly` | boolean | **true** | Default: only traces that threw. Pass `false` to include successful runs |
| `includeConfig` | boolean | false | `get`: also return `configuration` / `secureconfiguration` / `profile` (off by default; those fields can hold plaintext secrets) |
| `top` | integer | 20 | `list` rows (max 200); `summary` sample size (default 300, max 500) |
| `environment` / `environments` / `allEnvironments` | | Environment selection |

```json
{ "action": "summary", "environment": "sit", "hours": 168 }
{ "action": "list", "entity": "contact", "message": "Create", "hours": 48 }
{ "action": "get", "traceId": "44444444-4444-4444-4444-444444444444" }
```

Three things worth knowing:

1. **A successful trace stores an empty string, not null.** Filtering on `exceptiondetails ne null` alone lists clean runs as failures, so "failures only" is `ne null` and `ne ''`.
2. `summary` groups by plug-in type + message + entity + the first line of the exception. Three hundred failures usually collapse to a handful of signatures; the same signature means the same bug recurring.
3. Plug-ins write their own credentials into the message block (`ClientSecret` inside `secureConfig`). All three actions — `list`, `get` and `summary` — mask them as `***` in both the output and the artifact and tell you how many values they masked. **Traces count as business data** and need "Read business data" (`data.read`).

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
