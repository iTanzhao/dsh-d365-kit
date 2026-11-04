# Troubleshooting

**English** | [简体中文](../zh/troubleshooting.md)

## Do these three things first

```
plugin_manager list_plugins
d365_envs check=true
d365_health allEnvironments=true
```

The first shows whether the plugin is present and active; the second checks credentials and network; the third shows whether the environment is busy. Most "tool errors" can be pinned down in these three steps.

---

## Error code reference

| Error / symptom | Meaning | Fix |
| --- | --- | --- |
| `unknown-environment` | The environment key does not exist | Use `d365_envs` to list available keys; check the spelling on the settings page |
| AADSTS series / `invalid_client` | Wrong credentials, expired secret, or application not authorized | Regenerate the secret; confirm the application user exists in **this** environment |
| `data-read-forbidden` | This environment is not authorized to read business data | Settings page → Permissions → enable "Read business data" |
| `data-write-forbidden` | Not authorized to write business data | Enable "Create/Edit business data"; every write still needs confirmation |
| `environment-busy` | The environment is importing/publishing (`msdyn_solutionhistories` has an unfinished record) | Wait for it to finish; use `force: true` only after confirming it is a leftover |
| `plan-not-pending` | The plan is executing / was interrupted last time / has already run | Regenerate the plan; writes are not idempotent, so do not rerun an old plan |
| `unknown-solution` / `managed-solution` | The default solution does not exist or is managed | Switch to an **existing unmanaged** solution |
| `destructive-not-acknowledged` | Deleting a field/option value without passing `acknowledge: true` | Confirm explicitly, then pass it |
| `option-set-unreadable` | The field's local option set cannot be read (all type conversions failed) | Confirm the field really is an option set; read the hint in the response |
| `unknown-view` / `ambiguous-view` | The view name does not exist / several share the name | Pass `entity` to disambiguate |
| `HTTP 400 … Could not find a property named` | The environment lacks that column, or the column name does not fit this endpoint | The tool attempts degradation; if it still fails, use `select` to name existing columns explicitly |
| `0x80060888 … query parameter is not supported` | The endpoint rejects that parameter (e.g. `$top`/`$orderby` on `EntityDefinitions`) | The client already degrades automatically; keep this in mind when writing your own scripts |
| `0x80071151` | The customization lock is held (an import/publish is running) | Confirm with `d365_health` and wait it out; do not retry in a loop |
| `HTTP 429` | Service protection (about 6,000 requests / 5 minutes) | Lower `concurrency` (≤ 4) and retry later; only write requests retry automatically, and only on 429 |
| Publish times out at 60–300 s | `PublishAllXml` is slow on an org with 2,000-plus tables | Already switched to `PublishXml` per affected component; if it still times out, check `d365_health` |
| `GitLab 403` | Token scope is insufficient, or the user is below Reporter on the project | Use another personal access token or raise the role; Guest cannot read the repo or MRs |
| `GitLab 404` | Wrong project path or IID, or the token cannot see the project | Use the full MR link, or fill in the default project |

---

## Install / loading problems

### Tools do not appear

1. Run `plugin_manager list_plugins`, find `include:dsh-d365-kit`, and confirm `enabled=true` and `fiberPhase=active`;
2. Restart DSH right after installing (Web client plugins have a module graph cache);
3. If the entry is missing: `remove_bundle` then `install_bundle` (when link/pnpm thinks the package already exists it only returns `already-installed` and does not replace the code).

### Restart reports `duplicate factory registration` / `import failed`

The same bundle was executed twice. Check whether the name in these two places matches the package name:

- `window.__ModuleLoader__.load({ id: ... })` at the top of `client.js`
- `export const name = ...` in `index.js`

Renaming the module or the package makes it easy to miss these two "self-reported names". If it still reproduces, quit DSH completely, delete Electron's compiled caches, then start again:

```
%APPDATA%\@deepseek-ai\dsh-desktop\Code Cache
%APPDATA%\@deepseek-ai\dsh-desktop\Local Storage
%APPDATA%\@deepseek-ai\dsh-desktop\Session Storage
%APPDATA%\@deepseek-ai\dsh-desktop\Cache
%APPDATA%\@deepseek-ai\dsh-desktop\GPUCache
```

Only UI preferences are lost; sessions and config under `.dsh` are untouched.

### The settings page has no "D365 Toolbox"

The Host side may have loaded while the client half never made it into the module graph: restart once. If it is still missing, check whether the module id in `client.js` matches the package name (see above).

---

## Settings page errors

| Symptom | Cause | Fix |
| --- | --- | --- |
| Saving permissions reports "writes can only be initiated from the settings page" | The request lacks `x-d365-meta-write: 1`, or comes from another origin | Only act from the settings page; rejections are logged in `.d365/write-guard.log` |
| Opening a tab returns `HTTP 400` with no details | The route did not declare a request body schema, so the connection layer built a GET with a body | Upgrade to 0.18.0+ (fixed); older bundles need a restart |
| Config is unchanged after saving | `configFile` points somewhere else | The bottom of the settings page shows the config file path; pin it with `D365_CONFIG_FILE` or a patch |
| English appears in a Chinese UI | The DSH UI language is English | Expected: page copy follows DSH |

---

## Data problems

### A layer query returns 0 rows

`msdyn_componentlayer` is a virtual entity: you **must supply both the component id and the type**. Giving only the name, only the id, or no filter at all silently returns 0 rows (no error).

In some environments the table is readable but the application user cannot see the data; administrator identity is required.

### Snapshots are large

A single full snapshot is about 125 MB (200k solution components, 94k plugin steps, 66k web resources). The default keeps 2 per environment; `d365_reports action=compact` collapses the indented JSON onto a single line (measured: saves 68 MB).

### Diff reports are noisy

Narrow it with `resources` first; `organization` is skipped by default, and timestamps and `*id` columns do not participate in the comparison. Use logical names when comparing across environments.

---

## Write problems

### After execution it reports "plan does not exist"

The plan file is deleted once execution succeeds. Clicking an old card again or re-executing gives this message; check the recent change records under "Plans" on the settings page to confirm the result.

### The write succeeded but downstream cannot see it

1. Did the change land in the active default layer? Fill in "change default solution", otherwise exporting the solution will not carry it;
2. Is it covered downstream by another managed solution's layer? Check with `d365_layers`;
3. Was it published? Writes publish the affected components automatically; the result is in `.d365/changes/publish-<planId>.json`.

### The publish stays `running`

Publishing runs in the background and the sidecar file is written only when it finishes. Check `d365_health` to see whether that environment is still publishing; once nothing is active, rerun `PublishXml` — publishing itself is idempotent (a repeat publish does not change the result).

---

## Still stuck

Collect these before asking:

```
d365_envs
d365_health environments=["<that environment>"]
```

Plus the full error text, the timestamp, and `.d365/write-guard.log` (for settings-page write problems).
