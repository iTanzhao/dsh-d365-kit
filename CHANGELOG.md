# Changelog

**English** | [简体中文](CHANGELOG.zh-CN.md)

Versioning: bug fixes bump the patch, new tools/capabilities bump the minor, changes to the config structure or renames bump the major.

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
