# Permissions & Writes

**English** | [简体中文](../zh/permissions.md)

## Default posture

Right after installation the plugin is **read-only**:

- Metadata (entities, fields, forms, views, plugins, solutions, layers, sitemaps…) is governed by `metadata.read`, which is **on by default** — an environment that is not listed explicitly counts as granted;
- **Business records** are not readable by default; grant `data.read` per environment;
- Any change needs the matching capability granted per environment, and every execution needs a human confirmation.

"What you can see" and "what you can change" share one per-environment capability table, because the two belong together. The page renders one block per environment, separated by a rule.

## Capability table

Configured in `d365.config.json`:

```json
{
  "write": {
    "capabilityVersion": 2,
    "environments": {
      "dev": ["metadata.read", "data.read", "optionValue.add", "attribute.add", "view.columns"],
      "sit": ["metadata.read", "data.read"],
      "uat": []
    },
    "solutionUniqueName": "ContosoBase"
  }
}
```

- An environment with **no entry** has never been configured and keeps the default (only `metadata.read`);
- An environment whose entry is an **empty array** has everything revoked, including metadata;
- `capabilityVersion` is written by the settings page when it saves. Older files (without the field) get `metadata.read` added back to their existing entries, which preserves the pre-upgrade "metadata is always readable" behaviour.

| Capability | Real HTTP operation | Group | Effect |
| --- | --- | --- | --- |
| `metadata.read` | metadata `GET` | Metadata | Read tables/fields/forms/views/plugins/layers (on by default) |
| `data.read` | business-data `GET` | Data | Read business records |
| `data.write` | `POST` / `PATCH` | Data | Create or update business records (high risk, no deletions) |
| `optionValue.add` | `InsertOptionValue` | Option set | Add option values (global or field-local) |
| `optionValue.updateLabel` | `UpdateOptionValue` | Option set | Change option labels |
| `optionValue.delete` | `DeleteOptionValue` | Option set | **Permanently delete** option values (high risk) |
| `attribute.add` | `POST EntityDefinitions(...)/Attributes` | Field | Add fields |
| `attribute.update` | `PUT` field URL (`MSCRM.MergeLabels`) | Field | Change display name, description, required level |
| `attribute.delete` | `DELETE` field URL | Field | **Permanently delete** the field and its data (high risk) |
| `entity.update` | `PUT` entity URL (`MSCRM.MergeLabels`) | Table | Change table display name and description |
| `view.columns` | `PATCH savedqueries(id)` | View | Add or remove columns in system views (`layoutxml` only) |

Tick them per environment under Permissions in the settings page; "Copy to all environments" is supported.

## Three gates, one decision point

The decision lives in one place, `lib/client.js`, so a new tool cannot bypass it — every request (including "test connection" in the settings page) goes through it:

- **Metadata read**: the entity set name in the request URL is on the metadata allowlist (`EntityDefinitions`, `systemforms`, `savedqueries`, `webresourceset`, `solutions`, `msdyn_componentlayers`…) and requires `metadata.read`; it fails with `metadata-read-forbidden`;
- **Business-data read**: every other `GET` is blocked as business data and requires `data.read`; it fails with `data-read-forbidden`;
- **Write**: a request that is not `GET` and does not belong to a metadata message (`PublishXml`, `InsertOptionValue`, `CreateAttribute`…) must have `data.write` first, otherwise it fails with `data-write-forbidden`.

Every gate fires **before a token is acquired**, so the request never reaches the environment. Decisions are cached per environment for 2 seconds, so a change in the settings page applies to the next tool call.

## Two-step writes

### Step 1: generate a plan (read-only)

`plan-*` reads the current state, skips items with no change, writes the operations to a plan file (`.d365/pending-writes/`) and returns the operation list.

| Plan | Constraint |
| --- | --- |
| `plan-add-options` | Dedupes by the code before `\|`; new values continue from the current maximum +1; existing codes go to `skipped` |
| `plan-relabel` | Only items whose label actually changes go into the plan |
| `plan-option-delete` | Requires `acknowledge: true`; missing values go to `skipped`, and Dataverse refuses the delete when existing records reference the value |
| `plan-add-attribute` | The table must exist and the field must not; `SchemaName` must carry the publisher prefix |
| `plan-update-attribute` | Only items that really change are included |
| `plan-delete-attribute` | Requires `acknowledge: true`, otherwise it is rejected outright |
| `plan-update-entity` | Changes the display name / description only |
| `plan-view-columns` | Locates the system view by view name (same name distinguished by `entity`); only the cell list in `layoutxml` changes, filter conditions are left alone |

Local option sets (an option set carried by a field) are addressed with `entity` + `attribute`; global option sets with `optionSet`.

### Step 2: execute (needs a human)

```
Run mw04aul6-1ci6aa
```

The agent calls `d365_write action=execute planId=...`, which:

1. Reads the plan and checks that its status is `pending`;
2. Checks that the environment **still** holds this capability;
3. Checks whether the environment is importing/publishing (see below);
4. Shows a confirmation card: environment, targets, operation count, the first 10 operations; with deletions it adds an unrecoverable warning;
5. Click "Execute now" → operations are written one by one → publish runs in the background → the run is audited.

You can also review and execute from the Pending changes tab in the settings page (the same second, red confirmation). Both entry points share the same checks.

### Plan states

`pending → running → done / failed`

`running` is persisted before the first write, so a process killed midway never leaves behind a plan that still looks clickable. For a plan that is not `pending`, both the tool and the settings page **refuse** to execute or cancel it — writes are not idempotent, and a rerun would resubmit the parts that already took effect. To redo the work, generate a new plan.

### Pre-flight check

Dataverse holds a customization lock while importing or publishing. Microsoft first-party updates arrive as solution imports, and an environment spends a large part of the day doing exactly that — during which writes either fail with `0x80071151` or wait for the lock until they time out.

So before executing, the plugin looks for rows in `msdyn_solutionhistories` where `msdyn_endtime` is null:

| Case | Behavior |
| --- | --- |
| A row exists and its start time is within `busyWindowMinutes` (default 120 minutes) | Refuse to execute and report the operation in progress (`environment-busy`) |
| Only older rows (leftover zombie rows) | Do not block; mention it in the result |
| The table cannot be queried (no permission) | Skip the check and note in the result that it was skipped |

`force: true` skips it; use it only when you are sure the row is a leftover.

### Default solution

Every metadata change is recorded in some **solution layer**. Without a solution it goes into the active default layer (Default Solution), which does not travel with an exported solution, and downstream this shows up as "the field does not exist".

So fill in "Default solution for changes": the unique name of an **existing unmanaged** solution. It is validated at plan time — a name that does not exist fails with `unknown-solution`, a managed one with `managed-solution`, instead of waiting until execution to fail.

### Publish scope

After writing, only the **affected components** are published:

- Option set operations → the corresponding option set (field-local option set → the table that owns it);
- Field / table / view operations → the table that owns them.

The payload looks like:

```xml
<importexportxml>
  <entities><entity>account</entity></entities>
  <optionsets><optionset>contoso_taxcategoryos</optionset></optionsets>
</importexportxml>
```

One publish takes seconds to a dozen seconds, instead of the minutes `PublishAllXml` needs to recompute two thousand-plus tables. Only when the affected components cannot be derived does it fall back to a full publish. Publishing happens in the background, the result is written to `.d365/changes/publish-<planId>.json`, and the execute response carries `publishState` (`skipped` / `running`).

## Writing business data

Three constraints on `d365_data_write`:

- It needs `data.write`, off by default;
- It can write to **one** environment only;
- Every write shows a confirmation card; the request goes out only after approval.

Writes need no publish (business data is not metadata). The audit records field names only, never values. There is no delete.

## Safety boundaries

- **Write endpoints accept only the settings page**: `/write/policy`, `/write/cancel`, `/write/execute`, `/write/publish` require an `x-d365-meta-write: 1` header. A cross-site page must pass a CORS preflight to send that header, and these routes never answer preflights; if the request carries an `Origin`, it must also be same-origin. The auth channel rewrites the URL to `http://dsh.internal` and swallows `Origin`, so Origin alone cannot be the test. Rejected requests are logged to `.d365/write-guard.log`.
- **Retries only for safe methods**: `GET`/`HEAD` retry on network errors and 5xx; `POST`/`PATCH`/`DELETE` retry only on **429** (the server explicitly did not execute). A write timeout is reported as "may have taken effect", for a human to check in the environment, rather than being silently resent.
- **Republishing passes the same gate**: the environment must still hold the capability it had at the time, and an idle check runs first (a busy environment returns 409 rather than a raw 429).
- **Cancel rejects non-`pending` just like execute**: there is no "the page says cancelled while the backend keeps writing".
- **No rollback**: metadata deletions cannot be undone, so a delete requires `acknowledge: true`, and the card calls it out separately.
- Write endpoints expose no bulk script entry point and no "skip confirmation" switch; `force` skips only the idle check, never the confirmation.
