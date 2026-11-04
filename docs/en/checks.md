# Check Rules

**English** | [简体中文](../zh/checks.md)

Three check tools answer different questions:

| Tool | Question | Data source |
| --- | --- | --- |
| `d365_migrate` | What happens when this solution is imported into the target environment | Live read, layer lookup per component |
| `d365_contract` | Do downstream environments still honor upstream registrations and references | Live read (drift reflects the present) |
| `d365_code_check` | Will the code changes in this MR run in the target environment | GitLab MR + live environment read |

Shared convention: **high confidence blocks outright, medium confidence drops to a warning, anything static analysis cannot decide goes to manual confirmation** — better to have a human take one more look than to let a single false positive turn the tool into noise.

---

## Migration assessment (d365_migrate assess)

Component-by-component comparison produces these findings:

| Rule | Criterion | Level |
| --- | --- | --- |
| `component-missing` | The component does not exist in the target environment | info |
| `solution-absent` | The target does not have this solution (first import) | warning |
| `version-not-newer` | The target version is not lower than the source version (the import does not overwrite it with a newer one) | warning |
| `managed-mismatch` | Managed state differs between source and target | warning |
| `source-unmanaged` | The source is unmanaged, so the import leaves a layer that cannot be removed by uninstalling | warning |
| `option-values-lost` | Option values the target has and the source lacks — deleted by the import | **critical** |
| `option-label-drift` | The same value carries a different label | warning |
| `shadowed` | Another solution owns the top layer of this component in the target, so its definition is invalidated after import | listed in summary |

### Component types and layers

Only six types can be looked up by name in the layer table:

| `msdyn_solutioncomponentname` | componenttype |
| --- | --- |
| `Entity` | 1 |
| `Attribute` | 2 |
| `OptionSet` | 9 |
| `EntityRelationship` | 10 |
| `Workflow` | 29 |
| `WebResource` | 61 |

The remaining types (36 reports, 50 chart/security types, 70 app types…) have no matching name in the layer table, so they only get an **existence check** and are marked "not assessed" in the report.

The keys used to identify a component across environments come from the layer record's `msdyn_componentjson`: Entity → `logicalname`, Attribute → `logicalname` + parent table, OptionSet → `name`, EntityRelationship → `schemaname`, Workflow → `name` + `category`, WebResource → `name`.

### Why it is slow

`msdyn_componentlayer` is a virtual entity: it can only be queried one component at a time by "component id + component type" and cannot be fetched in bulk per solution; a single component takes about 2 seconds. Hence `maxComponents` (default 150) and `concurrency` (default 4, max 8), and only `full: true` assesses everything.

### Reading order for the report

1. Start with **critical**: are any option values lost;
2. Then **shadowing**: whose definition gets invalidated by the import, and is it one of your own managed patches;
3. Finally **missing pieces and versions**: a component missing from the target usually means the release pipeline skipped a step;
4. Landing the conclusion: if the change can join a managed solution and ride along with upgrades, do not ship a separate small unmanaged solution — layers stack by import time, and the next patch that comes in covers it again.

---

## Contract drift (d365_contract)

Treat upstream plugin registrations and visual component references as a **contract**, and check whether the downstream still satisfies it.

| Rule | Criterion | Level |
| --- | --- | --- |
| `assembly-missing` | Upstream has the assembly, downstream does not | Blocker |
| `assembly-version-older` | Downstream version is lower than upstream | Warning |
| `plugin-type-missing` | A type registered upstream is missing downstream | Blocker |
| `plugin-step-missing` | The type exists but the step for the "message + stage + mode" combination is missing | Blocker |
| `form-library-missing` | A web resource referenced by a downstream form does not exist | Blocker |
| `sitemap-missing` | An upstream custom sitemap is missing downstream | Warning |
| `handler-missing` | The function named by a form handler cannot be found in the project scripts | Warning |
| `option-value-missing` | Downstream is missing an upstream option value (or has a value upstream lacks) | Warning |

Details:

- Only **unmanaged** assemblies are compared by default; managed assemblies come from Microsoft or from a managed solution and cannot be changed locally;
- Steps compare by "type + message + stage + mode": async and sync are two different contracts;
- Option value comparison requires passing `optionSets` explicitly (each one is read from `GlobalOptionSetDefinitions`); without it, nothing is compared;
- Content that exists downstream but **not** upstream is never a blocker; when an option set has extra values the only hint is "confirm whether it has been back-ported".

### Handler check

With `handlers: true`, the project scripts referenced by forms are downloaded and checked for the existence of `functionName`.

- Only **project scripts** are judged. The prefixes are inferred from the source environment's unmanaged solutions — the publisher prefix that most of them use, plus `new_` — so a fresh install works against any organization without configuration; set `handlerPrefixes` to pin the list exactly. Partner and sample solutions are deliberately left out: their bundles are minified, so their internal names are mangled and every handler would look missing (on one real environment: 94 findings instead of 14);
- The handler's own library is checked first; if the function is not found, the search widens to the other project libraries the form loads (form-level shared scope really exists: one library provides the function, another binds it);
- Platform-injected handlers (`absoluteurl_onchange`, `Main_Form_onload`, etc.) come from system scripts and are not judged;
- Downloading is capped (400 scripts per environment); anything beyond that is treated as "content unreadable, cannot confirm" rather than falsely reported as a blocker.

The first version judged against "every script library a form loads" and produced 306 warnings; narrowed to "project libraries, own library first" it produces 14, all of them cases where the script was read and the function genuinely is not there. **That number is the design goal: a small actionable set, not an unreadable pile.**

### Waivers and trends

```json
{ "action": "waive", "rule": "form-library-missing", "env": "sit",
  "object": "/_static/_common/scripts/CommandbarActions.js", "reason": "this environment does not use SLA dialogs", "days": 30 }
```

- Stored in `.d365/waivers.json`; `env` accepts `*`, `object` accepts `*` and the prefix form `x*`;
- An expiry is mandatory (default 30 days); once expired the item reappears in the report automatically;
- The report shows "N waived", and waived items never enter the blocker list;
- Every drift run appends an entry to `.d365/reports/contract-history.json` (60 kept), and the next run over the same `source → targets` reports "new / gone".

### Why live data

Plugin registration scale: one environment has about 376 assemblies, 6,400 types, and 5,900 types with steps (about 94,000 step records), read in tens of seconds. Drift computed from a snapshot a few days old produces false conclusions, so no snapshots are used here.

---

## Code check (d365_code_check)

Reads the MR once and analyzes only the files it touches. Requires a read-only GitLab token (`read_api`); the token's user must be at least **Reporter**.

### JS / TS

Chain: changed file → match a web resource in the environment by **file name** (when paths differ, take the closest same-name candidate and mark it "inferred, pending confirmation" in the report) → find the forms that reference that resource → compare the changed lines one by one.

| Check | Verdict |
| --- | --- |
| A field read by an added line is on **no** form that loads the library | one blocker |
| The field is only on some forms (the script may never reach that branch on those forms) | warning, listing the missing forms (at most 3) |
| A referenced entity does not exist (form `datafieldname`, `Xrm.WebApi` entity set) | blocker |
| A deleted function is still referenced by a form handler | blocker |
| A deleted file is still referenced by a form | blocker (not reported when no form references it) |
| `columns.get('x')` | manual confirmation (view/subgrid column — not being a form field is normal) |
| A prefixed string subscript `["contoso_x"]` | manual confirmation (cannot tell statically whether it is a field or a plain key) |
| A newly introduced hard-coded GUID, option value, or environment URL | warning or manual confirmation |
| Configuration data, field-level security, the running user's privileges | manual confirmation (cannot be decided statically) |

Access patterns covered: `getAttribute`, `getControl`, `attributes.get`, `formContext.data.entity.attributes.get`, `Xrm.Page.getAttribute`, `attributes[...]`, and prefixed string subscripts.
Relying on a single `getAttribute` regex misses a lot of compiled output (measured: a 103 KB compiled TS script hit 0 times), so access is split into three groups: definitely a field, definitely a column, needs human judgment.

### C# / project files

Infer the assembly name from the **innermost project directory** in the path (an `<AssemblyName>` in the `.csproj` wins when present) → **exact match** against `pluginassemblies` in the environment → look up `plugintypes`, `sdkmessageprocessingsteps`, `sdkmessageprocessingstepimages`.

| Check | Verdict |
| --- | --- |
| The assembly does not exist in the target environment (shared projects such as `.Processes` fall here) | warning + manual confirmation of which assembly the file ultimately ships in |
| The source version differs from the environment assembly version | warning |
| An `IPlugin` class has no matching plugin type in the target environment | blocker |
| The type exists but has no steps at all (changes will never fire) | warning |
| Code reads `PreEntityImages["X"]` / `PostEntityImages["X"]` but the step has no such image registered | blocker (Create steps do not check pre-images) |
| A step's `filteringattributes` references a field that does not exist on the entity | blocker |
| An enumerated `contoso_*` literal is neither a table nor a global option set in the target | manual confirmation |
| Two or more steps on the same `message\|stage` | warning (execution order is undefined when ranks collide) |
| Code uses `secureConfig` / a constructor with two string parameters | manual confirmation (the Web API does not return secure configuration content) |
| APIs the sandbox may forbid (`System.IO`, `System.Net`, `Thread.Sleep`…) | warning |

Assembly names are matched exactly, never approximated — a wrong guess checks types and steps against the wrong assembly, which is worse than not checking at all.

### Report structure

```
Changed file table
Per-file impact (which resource/assembly it maps to, which forms/types)
Blockers (must fix)
Warnings (should fix, or register a waiver)
Manual confirmation (HC-01…, each entry states why a machine cannot decide)
```

### Known limits

- Only the MR's added and removed lines are analyzed; no other repository files are read (no import resolution, no call-chain following);
- Path → web resource name is inferred from the file name, and marked "inferred" when the repository path and the resource name disagree;
- C# filtering attributes, images, and types are judged from registration data only; secure/unsecure configuration content and implicit ordering beyond rank still need manual confirmation;
- The running user's privileges and the actual shape of the data are not judged.

---

## Division of labor between the three checks

```
Code change ──d365_code_check──> can this change ship (one-off, MR-level)
Upstream vs downstream ──d365_contract──> is the contract between environments broken (ongoing, version-level)
Solution ──d365_migrate──> will this import shadow someone else (one-off, release-level)
Who overrode it ──d365_layers──> why this environment looks the way it does
Who uses it ──d365_refs──> the impact of changing or deleting it
```

They do not replace each other: `d365_layers` tells you who overrode it, `d365_refs` tells you who references it, and `d365_code_check` tells you whether the lines you changed land on something that does not exist.
