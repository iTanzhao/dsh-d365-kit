# Changelog

**English** | [简体中文](CHANGELOG.zh-CN.md)

Versioning: bug fixes bump the patch, new tools/capabilities bump the minor, changes to the config structure or renames bump the major.

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
