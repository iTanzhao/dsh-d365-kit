# Changelog

**English** | [简体中文](CHANGELOG.zh-CN.md)

Versioning: bug fixes bump the patch, new tools/capabilities bump the minor, changes to the config structure or renames bump the major.

## 0.29.0

This one fixes the ways the toolkit could mislead you while "looking at structure": dropped error codes, silently truncated lists, unreadable derived columns, and artifacts you could not read back.

- Fixed: `D365Error` keeps the Dataverse error code and response body. `0x80048d19` used to survive only inside a Chinese one-liner, where it could neither be copied nor searched; errors now carry `errorCode` and `body`, and the message appends what that code means and what to do next (`0x80048d19` payload shape, `0x80060888` unsupported property or query parameter, `0x80040333` duplicate detection, `0x80044150` concurrency conflict, and so on);
- `d365_metadata` gains a `step_images` resource (plug-in step registration images: image type, alias, attributes) and `plugin_steps` now expands the plug-in type and message name by default — a step's `name` is often blank, so the digest could not tell you which step it was;
- List resources (`plugin_steps`, `plugin_types`, `step_images`, `attributes`) default to 1000 rows instead of 200. A mature organization has 5000+ `sdkmessageprocessingsteps` in practice; 200 rows sorted by name makes the step you want look absent;
- A truncated result now reads "N shown / M total" (`M` from the server's `$count`, which itself caps at 5000 and is shown as ≥5000) instead of a vague "there is more";
- `d365_metadata` supports keyed attribute reads cast to a derived type (`attribute` + `cast`): `DefaultValue`, `OptionSet`, `Targets` are not on the `AttributeMetadata` base type, and selecting them used to return 400;
- An explicit `select` now also decides which columns the digest table shows (it used to always render the resource's default columns, hiding the `DefaultValue` you asked for);
- `d365_health` adds a plug-in trace column (organization `plugintracelogsetting`: off / exception only / all). The most common reason a trace is missing is that it is off, and that was previously invisible;
- `d365_reports` gains `action=view`: read an artifact back through a line window, with `match` filtering, `offset`/`limit` paging, `wrap`, and JSON indented by default; only files under `.d365` are readable, and an absolute path pointing elsewhere is refused. Before this, a 500 KB result was "a file name and a size", which is the same as not saved.

## 0.28.1

Migrations bind lookups by their real navigation property name, and the settings page follows the DSH language again.

- Fixed: `d365_data_sync` used to build `@odata.bind` keys from the attribute's logical name, while the Web API keys them by the relationship's **navigation property** name. Custom relationships often differ (`contoso_approverid` binds as `contoso_ApproverId`, `contoso_geographicunitid` as `contoso_GeographicUnitId`), so those fields failed every row with `0x80048d19 … An undeclared property` while the preview looked clean. Each entity now reads a logical-name → navigation-name map from `RelationshipDefinitions` and writes by that name; the plan lists the fields where the two differ, and falls back to the logical name (saying so under "notes") when the map cannot be read;
- Fixed: plans saved by older versions carry no such map, so `execute` now rejects them with `stale-plan` and asks for a fresh `plan` instead of repeating the old failure;
- Write requests now send `content-type: application/json; charset=utf-8`, so non-ASCII values no longer depend on the server guessing the encoding;
- Fixed: the settings page read `ctx.get('locale')` once inside `apply`, so a locale service that arrived later was never seen and the page stayed English. It now uses `ctx.inject(['locale'])` to wait for the service and pushes language changes to already-mounted pages; the dictionaries are registered in one `register('d365-meta', DICT)` call.

## 0.28.0

Removing an unmanaged layer now works for every component type, not just tables and columns.

- `d365_write plan-remove-layer` accepts all eleven `componentType` values (`Entity`, `Attribute`, `OptionSet`, `SavedQuery`, `Workflow`, `SystemForm`, `WebResource`, `PluginType`, `PluginAssembly`, `SdkMessageProcessingStep`, `CustomAPI`); the numeric `ComponentType` each one sends to `RemoveActiveCustomizations` comes from the `solutioncomponent.componenttype` picklist read from the live service, not from guesswork (CustomAPI carries its table's object type code, 10519);
- The plan now renders the whole layer stack before the operation and names what takes over after removal, so the destructive step is reviewable without opening the JSON;
- Publish scope after removal follows the component: a table or column publishes that table, a form or view publishes its owning table, an option set publishes that option set, and everything else publishes the whole environment — an unknown or unowned component falls back to a full publish rather than a wrong narrowed one;
- Fixed: a form that belongs to no table made Dataverse answer `objecttypecode` with the literal `none`, which the publish step would have passed on as a table name; it now reads as "no narrowed scope".

## 0.27.0

Global option sets got their layers, the layer output says what `Active` means, and a token is fetched once instead of once per request.

- `d365_layers` accepts `componentType: OptionSet`: it resolves the global option set through `GlobalOptionSetDefinitions(Name='…')` → `MetadataId`, then queries the layer table with `msdyn_solutioncomponentname = 'OptionSet'`. Local option sets live with their column, so those are still inspected via `componentType: Attribute` plus `entity`;
- Layer rows now label the unmanaged layer as `Active (unmanaged)` and each environment ends with a sentence saying whether its top layer is unmanaged or whether the environment has no unmanaged layer at all; an Active layer's timestamp reads "not recorded" (`msdyn_overwritetime` is always `1900-01-01` for it, which previously rendered as a fake date);
- `d365_metadata` grew a `name` parameter for `option_sets`: one keyed request instead of pulling all 987 definitions, with 404 reported as "this environment has no global option set named X";
- Passing `filter` to `option_sets` is rejected up front (`filter-unsupported`) instead of surfacing the raw `$filter is not supported` failure — the endpoint answers HTTP 405;
- Token acquisition is single-flight: concurrent requests to the same environment now share one token request (measured: 8 parallel calls used to make 8 OAuth requests, now 1), and the refresh skew is 2 minutes instead of 1;
- The `d365_layers` description now lists all eleven supported component types, so a wrong `componentType` no longer needs a failed call to discover.

## 0.26.0

Solution layers are now writable, in exactly one way: remove the unmanaged layer.

- New `d365_write` action `plan-remove-layer` and capability `layer.remove` ("Remove custom layer", high risk, off by default): it deletes the top-most layer of a table or a column **only when that layer reads `Active`** — the unnamed unmanaged layer — so whatever a solution last shipped becomes active again;
- The plan renders the whole layer stack, the layer being removed and the layer that takes over (or "system definition" when nothing is below); execution goes through the same confirmation card and the same publish step, narrowed to the affected table;
- `RemoveActiveCustomizations` is the only message behind it. A top layer owned by a solution is refused up front (`not-active-layer`): those definitions belong to that solution — remove the component there, or ship a patch that overrides it;
- `DeleteAndPromote` and `RemoveSolutionComponent` are deliberately not implemented;
- The layer helpers (`COMPONENT_TYPES`, `resolveComponentId`, `buildComponentFilter`) moved from `lib/tool-layers.js` to exports so read and write share one resolver;
- `RemoveActiveCustomizations` joined the metadata-write allowlist, so the operation needs `layer.remove` rather than `data.write`.

## 0.25.0

Metadata reads are now a permission of their own, and the Permissions page shows one block per environment instead of one wide table.

- New capability `metadata.read` ("Read metadata"), on by default and listed first in the settings page: turning it off makes tables, fields, forms, views and layers unreadable too, so every request now consults the policy — nothing reaches an environment without passing a gate;
- `lib/client.js` decides in one place: metadata entity sets need `metadata.read` (`metadata-read-forbidden`), every other `GET` needs `data.read` (`data-read-forbidden`), non-`GET` writes need `data.write` (`data-write-forbidden`) — all before a token is acquired;
- The Permissions page renders each environment as its own block separated by a rule, with a `granted/total` summary per environment; the "metadata is always readable" note now appears once above the blocks;
- `write.environments` entries are now three-state: absent = not configured (metadata read on), empty array = everything revoked, a list = exactly those capabilities. Empty arrays were previously dropped on read, which silently re-enabled the default;
- `write.capabilityVersion` (2) tells the loader that an older file's entries predate `metadata.read`; those entries get it added back so behaviour after upgrading is unchanged.

## 0.24.1

The first real write of 550 rows failed in full: every request came back `0x80048d19 … A 'PrimitiveValue' node with non-null value was found when trying to read the value of the property 'contoso_bg'`. Nothing was written, so the same plan was re-run after the fix.

- Lookups are now sent as `@odata.bind` navigation properties — `"contoso_bg@odata.bind": "/contoso_geographicunits(<guid>)"` — instead of a bare GUID in the attribute column, which Dataverse rejects for every lookup;
- `ownerid` is bound the same way, to `/systemusers(...)` or `/teams(...)` depending on what the source owner actually is, and only when the owner is remapped;
- Deferred lookups (their target GUID only known after the parent is created) are dropped from the create body and re-applied by `PATCH`; the previous code only handled plain columns there;
- The offline write-path test now asserts the real shape of the request body instead of `a key exists`, which is why the bare-GUID form passed the earlier test.

## 0.24.0

`d365_data_sync`'s dry run now follows how migration is actually requested: the first real run (SIT → DEV) exposed that a plan could be produced without ever asking about scope.

- The plan states three things and asks for confirmation: **scope** (whole table by default; narrow it with `since` / `filter` / `ids` / `fetchXml` when the volume is large), **fields** (all by default; a list containing the primary key means GUIDs are kept), and **whether to bypass custom plugins** (on by default);
- An omitted scope is no longer an error: it plans the whole table and notes, under "things to note", how many rows were read, whether `maxRecords` was hit, and that the rest is not in this plan;
- The plan gained a "permissions (execute needs)" block — read on source, read on target, write on target — so a missing `data.write` is called out up front instead of surfacing as a refusal at `execute` time;
- Bypass defaults to on (the target's synchronous plugins do not fire, so downstream notifications/integrations are not triggered); `execute` can still pass `bypassPlugins=false` explicitly.

## 0.23.0

New tool: `d365_data_sync`, business-record migration between environments.

- Two-stage: `plan` is a read-only dry run (saved under `.d365/data-sync/plans`), and `execute` writes only after a human approves a confirmation card (runs are logged under `.d365/data-sync/runs`). The plan states volume, the field list, how every lookup resolved, owner mapping, conflicts and whether custom plugins will be bypassed;
- Mirror by default: source GUIDs are kept (`overriddencreatedon` preserves creation time, `MSCRM.SuppressDuplicateDetection` is sent). With `keepGuid: false` the target assigns ids, references inside the batch are remapped in dependency order, and a second `PATCH` pass fills lookups that pointed at a record created later — cycles included;
- Lookups resolve by same GUID in the target first, then by exact primary name; no match is "missing", several are "ambiguous". Polymorphic lookups are resolved to a real table by reading the source first, because `Targets` cannot be selected on the base `AttributeMetadata` (0x80060888) — it is read from `LookupAttributeMetadata` instead;
- The scope must be explicit (`since` / `filter` / `ids` / `fetchXml`, or `mode=all` with `maxRecords`); an unclear scope is an error, never a guess;
- A GUID that already exists in the target is reported, not written; `conflict="overwrite"` turns those into per-row `PATCH`es. Missing references skip the affected rows by default, `null` clears them, `fail` refuses the plan;
- Same two permission gates: `plan` needs `data.read` on both ends, `execute` also needs `data.write` on the target. Creates and updates only — never deletes.

## 0.22.2

Correctness fixes found against a real UAT organization.

- `d365_health` no longer reports Completed async jobs as failures, or Ready jobs as suspended: `asyncoperation` uses `statecode` 0 Ready / 1 Suspended / 3 Completed, and failure is `statuscode 31` (Completed also covers 30 Succeeded and 32 Canceled). On the UAT org "recent failures" dropped from 59,293 to 124 — exactly what `statecode eq 3 and statuscode eq 31` reports — and the failure list no longer contains succeeded jobs (one listed job had 577/577 rows at statuscode 30). Ready jobs get their own "queued" column, and failures carry the real `operationtype`;
- `d365_metadata` resource `workflows` (and `business_rules`) now returns only the definition row (`type eq 1`) by default: Dataverse stores a second, same-named activation row (`type 2`, different `workflowid`) for every process, so each one appeared twice and counts doubled. An explicit `filter` replaces the default instead of ANDing with it (so `type eq 2` works), and `type` is a displayed column;
- `d365_layers` no longer aborts a multi-environment query when one environment lacks the component: a 404 on the keyed metadata lookup means "absent here", it is reported for that environment only, and the other environments still return their layers and take part in the comparison. The call fails only when every environment lacks it;
- artifact paths are absolute (`writeArtifact`), so the path printed in a result can be opened from the session workspace instead of `../../../Documents/...` relative to the plugin's cwd.

## 0.22.1

Packaging for npm.

- `package.json` gains `repository`, `homepage`, `bugs`, `keywords`, `author` and `publishConfig.access: public`, so the package page on npm is not empty;
- the docs now list npm as installation option 1 (`install_bundle target="dsh-d365-kit@<version>"`), with Git and local directory as the fallbacks; `PUBLISH.md` covers `npm publish` for both public npm and an internal registry.

## 0.22.0

Portable configuration.

- The handler check no longer ships with a hard-coded project prefix: `handlerPrefixes` defaults to empty, and the prefixes are inferred from the unmanaged solutions of the source environment (the publisher prefix most of them use, plus `new_`). Partner and sample solutions are filtered out because their minified bundles made every handler look missing;
- the drift report and the tool output show which prefixes were used and where they came from (`config` or `publishers`);
- `d365.config.example.json` gains `handlerPrefixes`.

Verified on a real environment: with the inferred prefixes the handler check produces exactly the same 14 findings as the previously pinned list.

## 0.21.0

Housekeeping release.

- Docs reorganized: the README is now the entry point, with new `docs/` (installation, tool reference, scenarios, permissions, check rules, troubleshooting, architecture) and `examples/`;
- added `CHANGELOG.md` and a root `.gitignore`;
- **every document now exists in English and Chinese**: `README.md` / `README.zh-CN.md`, `INSTALL.md` / `INSTALL.zh-CN.md`, `CHANGELOG.md` / `CHANGELOG.zh-CN.md`, `docs/en/` / `docs/zh/` (same file names), `examples/prompts.en.md` / `examples/prompts.zh-CN.md`, each with a language switch at the top;
- `d365.config.example.json` now covers the permissions, retention policy and GitLab sections;
- added docs and examples to `files` in `package.json`;
- released under the MIT license (`LICENSE`, `"license": "MIT"`).

The code is identical to 0.20.0, with no behavior changes.

## 0.20.0

Renamed to `dsh-d365-kit`.

- the package name, bundle entry id, `name` in `index.js` and module id in `client.js` are all `dsh-d365-kit` now;
  the last two are names reported at runtime, and missing one makes the loader execute the same module twice, which
  raises `duplicate factory registration` and makes the whole settings page disappear;
- settings page title is now "D365 Toolkit", with a description covering the read, write and check capability groups;
- `tools` in `locale/{zh,en}.json` filled out to 15 entries;
- added `INSTALL.md`; the comments in `cordis.patch.yml` are UTF-8 again.

## 0.19.1

Four fixes from a review.

- `/write/cancel` checks plan state: anything not `pending` returns 409, so a plan that is running can no longer be deleted;
- `/write/publish` re-checks write permission and environment idleness, returning 409 when busy instead of the raw 429;
- blocking on file deletion is now reported only when forms really still reference it;
- JS reference analysis split into three groups — field / column / needs human judgement — with missing fields aggregated per field: missing from all forms = blocking, missing from only some = warning.

## 0.19.0

- `executePlan` gained a plan state machine `pending → running → done/failed`, writing `running` before the first write; both the tools and the settings page reject plans that are not `pending`;
- retry policy now differs by method: `GET`/`HEAD` retry on network errors and 5xx, `POST`/`PATCH`/`DELETE` retry only on 429;
- the form Handler check was narrowed: project scripts only, own libraries queried first, a budget of 400 scripts, dropping false positives from 306 to 14;
- `d365_reports` totals now come from disk statistics, and truncation is marked explicitly;
- the health check no longer renders an empty failure reason.

## 0.18.0

Data governance.

- retention policy: snapshots / reports / diffs / query evidence / change records each have a count and a day limit, cleaned up automatically after artifacts are written;
- `d365_reports` gained `cleanup` (dry run by default) and `compact` (squeezes indented JSON onto a single line);
- the settings page gained a "Data" tab: usage, per-category breakdown, dry run and execution, compaction;
- snapshot writes switched to single-line JSON, saving 68 MB across four snapshots as measured;
- fixed a settings-page route that returned a bare 400 on GET because it didn't declare a request body schema.

## 0.17.0

- contract waivers (`waivers.json`, expiry date required) and drift trend (`contract-history.json`);
- contract checks now also cover the Web resources referenced by forms, the sitemap and form Handlers;
- added `d365_health` (suspended/failed jobs, running imports and publishes);
- added `d365_reports` (artifact index);
- warn about rank conflicts when several steps share the same `message|stage`; JS value-reading patterns extended to 9;
- snapshot staleness hints, and "copy permissions to other environments".

## 0.16.0

Contract matrix and drift engine `d365_contract`: assemblies, plugin types, steps (message + stage + mode), option values.

## 0.14.0 – 0.15.0

- `data.write` and `d365_data_write`: create/update business records, requires authorization and a confirmation every time, and the audit log records no values;
- `d365_code_check` gained a C# branch: exact assembly matching, type/step/image/filtering attribute checks, shared projects downgraded to warnings.

## 0.11.0 – 0.13.0

- `d365_code_check`: GitLab MR → Web resource → form field/Handler checks, reporting blocking/warning/manual confirmation;
- the settings page gained a GitLab tab (URL, default project, read-only token, connectivity test);
- `d365_refs`: reverse index for fields / Web resources / assemblies;
- `d365_data`: count / group by / sample, governed by `data.read`.

## 0.7.0 – 0.10.0

- the settings page became six tabs (Environments, Permissions, Plans, Data, GitLab, General), with the language following DSH;
- pre-execution check: refuse writes while the environment is importing/publishing;
- publish only the affected components (`PublishXml` instead of `PublishAllXml`), running in the background and recording the result;
- migration assessment `d365_migrate`: layer shadowing, missing components, lost option values, versions and managed state.

## 0.1.0 – 0.6.0

- metadata queries (19 resource kinds), multi-environment alignment;
- solution layers `d365_layers` (virtual entity, must have component id + type);
- snapshots `d365_sync` and diffing `d365_diff` (manifest records completeness, noise filtering);
- environment configuration and the settings page;
- write capabilities: add/update/delete option set values, add/update/delete fields, entity display names, system view columns; plan → human confirmation → execution → audit;
- fixed a batch of real-environment differences: missing `organization` columns, the metadata endpoint not supporting `$top`/`$orderby`, the token cache not being invalidated after switching user, and the layer table requiring a type.
