# Prompts You Can Copy and Paste

**English** | [简体中文](prompts.zh-CN.md)

The agent picks the tools and fills in the parameters on its own. All you have to do is be clear about **environment + object + the answer you want**.
Every phrasing below has been tested, and it works far better than something like "check the metadata".

---

## Start with the environments

```
Connect to all four environments and tell me what each one is doing.
```

```
Is anything importing or publishing in SIT right now? I want to change some metadata.
```

```
Which background jobs failed between yesterday and now?
```

## Querying metadata

```
Which custom fields are on account? Only list the ones starting with contoso_.
```

```
List the 10 most recently installed solutions, with version and managed status.
```

```
Which scripts does the main Account form load, and which events is each one bound to?
```

```
Which business rules apply to opportunity?
```

## Layers (why this environment looks like this)

```
How many layers does account have in each of the four environments, and which solution is currently on top?
```

```
Which solutions have overridden the account.name field?
```

```
Why is the Account form in SIT different from DEV? Who overrode it?
```

## Blast radius (before you change or delete anything)

```
Which forms, views, and processes use the contoso_customertier field? Check both DEV and SIT.
```

```
Which forms reference the contoso_/scripts/account_form.js script?
```

```
How many types and steps are registered from the Contoso.Customizations assembly, and what version is it?
```

```
For the contoso_taxcategory option set, how many customer records use each value?
```

## Snapshots and diffs

```
Snapshot the forms, views, and fields in DEV and SIT, then tell me the differences.
```

```
What's new in DEV's metadata today compared with the previous snapshot?
```

```
How do the plugin steps differ between SIT and UAT?
```

## Release assessment

```
What are the risks of shipping ContosoBase from DEV to SIT and UAT?
```

```
Once this solution is imported, whose layers will it overwrite?
```

```
What happens on import if the target environment doesn't have this solution?
```

## Code review checks

```
Will this MR break when it goes to UAT? https://gitlab.example.com/.../merge_requests/7759/diffs
```

```
For the form scripts this MR changes, do all the fields they read exist on the forms in the target environment?
```

```
This MR touches a C# plugin — are the assembly, types, steps, and step images all in place in the target environment?
```

## Contract and drift

```
Has SIT and UAT caught up with DEV's plugin registrations?
```

```
Are any web resources referenced by forms missing downstream?
```

```
This difference is known — log it as a waiver for 30 days.
```

```
Is there more drift or less drift than last time?
```

## Writes

```
Add these options to contoso_taxcategoryos: AD3|Andorra: Tax Register Number (plan only for now, don't execute)
```

```
Add a text field contoso_CustomerTier to account, 120 characters, display name "Customer Tier".
```

```
Change the display name of account.name to "Customer Name".
```

```
Execute mw04aul6-1ci6aa
```

```
Cancel that plan.
```

The general pattern for writes: **say what you want changed → confirm "plan only" → review the list, then say "execute <planId>"**.
If you merge those two sentences into one, the agent still generates a plan first and then shows a confirmation card — it never writes directly.

## Business data

```
How many records are in contoso_systemconfiguration? Group them by contoso_containsecret.
```

```
Show me 5 sample contoso_systemconfiguration records — I only need the contoso_key and contoso_value columns.
```

```
Add a record to contoso_systemconfiguration for me: contoso_key = FEATURE_X, contoso_value = 1.
```

(The last one needs the `data.write` permission and will show a confirmation card.)

## Housekeeping

```
How much space is .d365 using now, and what can be cleaned up?
```

```
Clean up the saved query artifacts according to the retention policy — dry run first, don't actually delete.
```

```
Compact the snapshots, they're taking up too much space.
```

---

## Phrasing tips

| To get a sharper answer | Say this |
| --- | --- |
| Pin down the environment | "in SIT", "look at all four environments" |
| Pin down the scope | "only the ones starting with contoso_", "main form only" |
| Want a verdict, not a list | "tell me whether it's safe to delete", "give me a one-line verdict" |
| Want evidence | "list exactly which forms" |
| Before a write | "plan only", "don't execute" |
| Large-scale operations | "assess first, don't touch the environment" |

Conversely, avoid these — they force the agent to guess:

- "Check the metadata" (which kind? which environment?)
- "See if there's a problem" (what problem? release, references, or contract?)
- "Change this field" (change it to what?)
