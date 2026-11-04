# Usage Scenarios

**English** | [简体中文](../zh/scenarios.md)

Everything below can be said to the agent as-is. Tool arguments are in brackets; the agent fills them in itself.

---

## 1. Taking over an environment: get the lay of the land

```
Connect to all four environments and see what each one is doing.
```

```
d365_envs check=true
d365_health allEnvironments=true hours=24
d365_metadata resource=organization
d365_metadata resource=solutions top=10 orderby="installedon desc"
```

What you get: whether each environment is reachable, its org version, hung/failed jobs, imports and publishes in progress, and what was installed recently.

This is the first step before answering any "does the environment have X" — it keeps you from mistaking "not configured" for "not present in the environment".

---

## 2. Can this field be deleted?

```
Which forms, views, and workflows still use contoso_customertier on account? Also check how many records still carry a value.
```

```
d365_refs  kind=field entity=account attribute=contoso_customertier allEnvironments=true
d365_data  action=group entity=account field=contoso_customertier top=10
d365_layers component=contoso_customertier componentType=Attribute entity=account
```

Three pieces of evidence together:

- **References**: 17 forms, 64 views (62 columns / 50 filters), 0 workflows/business rules;
- **Data**: the distribution of records that have a value for the field (empty is its own bucket);
- **Layers**: who added the field and which solution owns the active layer — if it comes from a managed solution you cannot delete it locally, only the publisher can change it.

The delete itself is `d365_write action=plan-delete-attribute ... acknowledge=true`, but you usually use these three pieces of evidence to convince people first.

---

## 3. Why two environments differ

```
Sync forms, views, and fields from DEV and SIT, tell me the differences, then explain why the Account form differs.
```

```
d365_sync   environments=["dev","sit"] resources=["forms","views","solutions"] includeAttributes=true entities=["account"]
d365_diff   base=dev head=sit resources=["forms","views","attributes"]
d365_layers component=Account componentType=SystemForm allEnvironments=true
```

`d365_diff` gives the mechanical difference (which rows were added/removed, which fields changed); `d365_layers` gives the reason (who overrode it, who sits on top).

Noise is already handled: timestamps and `*id` columns are not compared, and `organization` is skipped by default. When form content differs a lot, the field-level diff in the report reads far better than a wall of XML.

---

## 4. Assessing a solution before release

```
What are the risks of shipping ContosoBase from DEV to SIT and UAT?
```

```
d365_migrate action=assess source=dev solution=ContosoBase targets=["sit","uat"]
```

The report answers:

- whether the targets have this solution, and whether the source version is newer;
- who owns the top layer of each component in the target, and which solutions' definitions get shadowed after import (shadowed solutions are listed, sorted by component count);
- whether option set values will be lost (a value the source has and the target lacks = critical; mismatched labels = warning);
- which components the target is missing;
- when the source is unmanaged, the layer the import creates cannot be cleared by uninstalling a solution.

A real case: for a solution holding just 1 global option set, the assessment can come back as "0 critical, 2 warnings, but it will invalidate the definitions of 7 solutions" — the decision that actually matters is not about losing data, it is that **the next time anyone imports a Contoso patch, that layer gets covered again**.

---

## 5. Checking whether an MR can ship to UAT

```
https://gitlab.example.com/contoso/powerapps/-/merge_requests/7759/diffs will this MR cause problems if it goes to UAT?
```

```
d365_code_check mergeRequest="https://gitlab.example.com/contoso/powerapps/-/merge_requests/7759/diffs" targets=["uat"]
```

Three sections come out:

- **Blockers**: a field is on none of the forms that load the library, an entity does not exist, a deleted function is still referenced by a handler, a C# type/step/image is missing;
- **Warnings**: a field is only on some forms, the assembly version was not bumped, a hard-coded GUID;
- **Manual confirmation**: configuration data, secure configuration, privileges, ambiguity between a column name and a plain key.

The report is at `.d365/reports/code-check-<MR>-<timestamp>.md`.

C#-only MRs work too: infer the assembly from the project directory → exact match → look up types/steps/images/filtering attributes. Assembly names are matched exactly only; guessing wrong is worse than not checking.

---

## 6. Filling in a batch of option values

```
contoso_taxcategoryos is still missing 36 tax registration number types; add them to DEV from the list in .d365/reports.
```

```
d365_write action=plan-add-options environment=dev optionSet=contoso_taxcategoryos \
  labels=["AD3|Andorra: Tax Register Number (NRT)", "..."]
```

The plan returns the list of operations (values continue from the current maximum +1; codes that already exist go into skipped). Once checked:

```
Run mw04aul6-1ci6aa
```

A card pops up in the conversation → approve → write → publish only this option set. The audit trail is in `.d365/changes/`, the publish result in `.d365/changes/publish-<planId>.json`.

**Do not append them by hand in the remaining environments**: let them ride along with the solution import, otherwise the next time someone imports a managed patch your hand-added layer gets covered.

---

## 7. Upstream changed a plugin — what is downstream missing

```
Has SIT and UAT caught up with DEV's plugin registrations? Also check whether any scripts referenced by forms are missing.
```

```
d365_contract action=drift source=dev targets=["sit","uat"] forms=true
```

Typical result (real data): 86 findings = 4 missing assemblies, 72 missing plugin steps, 8 missing types, 2 missing form libraries.
`forms=false` skips reading formxml; `handlers=true` downloads scripts to check that the functions exist (slow, up to 400 scripts per environment).

Register a waiver for differences that are genuinely allowed:

```
d365_contract action=waive rule=form-library-missing env=sit \
  object="/_static/_common/scripts/CommandbarActions.js" reason="this environment does not use SLA dialogs" days=30
```

The next run over the same `source → targets` reports a trend of "N new / M gone".

---

## 8. Publish is stuck / can I write now

```
Is any import or publish running in the four environments right now? I want to change some metadata.
```

```
d365_health allEnvironments=true
```

If an environment has a `Publish` or an import in progress, any write gets `0x80071151` or waits until the lock times out. Wait for it to finish; `d365_write execute` checks this step itself and refuses outright when the environment is busy instead of throwing a raw 429.

Only use `force: true` once you have confirmed that record is a leftover (for example, an import that was interrupted days ago).

---

## 9. Disk is bloated by artifacts

```
How big is .d365 now? What can be cleaned up?
```

```
d365_reports action=list
d365_reports action=cleanup target=query            # dry run only by default
d365_reports action=cleanup target=query dryRun=false
d365_reports action=compact                         # compact snapshot JSON to one line
```

Real data: four full snapshots take about 540 MB, and compacting to one line saves 68 MB; within a single snapshot, `plugin_steps.json` is about 55 MB, `solution_components.json` about 39 MB, and `web_resources.json` about 20 MB.

For the retention policy and automatic cleanup, see [tools.md](tools.md#d365_reports) and the [root README](../../README.md).

---

## Combined usage

| Question | Combination |
| --- | --- |
| Is it safe to change this field | `d365_refs` + `d365_data` + `d365_layers` |
| Can this version ship | `d365_health` + `d365_migrate` + `d365_contract` |
| Can this MR merge | `d365_code_check` + `d365_refs` |
| Where do the environments differ | `d365_sync` + `d365_diff` + `d365_layers` |
| Why does it fail at runtime | `d365_refs` (field/script references) + `d365_layers` (who overrides) + `d365_health` (jobs) |
