# 使用场景

**[English](../en/scenarios.md)** | 简体中文

下面这些都是可以直接对 agent 说的话。工具参数在括号里，agent 会自己补。

---

## 1. 接手一个环境，先摸清楚

```
四个环境都连一下，看看各自在干什么。
```

```
d365_envs check=true
d365_health allEnvironments=true hours=24
d365_metadata resource=organization
d365_metadata resource=solutions top=10 orderby="installedon desc"
```

得到：每个环境是否连通、组织版本、挂起/失败作业、正在进行的导入发布、最近装了什么。

这是回答任何「环境里有没有 X」之前的第一步——避免把「没配置」误说成「环境里没有」。

---

## 2. 这个字段能删吗

```
account 上的 contoso_customertier，现在还有哪些表单、视图、流程在用？顺便看下还有多少条记录带着值。
```

```
d365_refs  kind=field entity=account attribute=contoso_customertier allEnvironments=true
d365_data  action=group entity=account field=contoso_customertier top=10
d365_layers component=contoso_customertier componentType=Attribute entity=account
```

三份证据合起来：

- **引用**：17 张表单、64 个视图（列 62 / 筛选 50）、0 条流程/业务规则；
- **数据**：该字段有值的记录分布（空值单独一档）；
- **层**：这个字段是谁加的、当前生效层是哪个解决方案——如果来自受管解决方案，本地删不掉，只能让发布方改。

删除本身是 `d365_write action=plan-delete-attribute ... acknowledge=true`，但通常先用这三份证据说服人。

---

## 3. 两个环境为什么不一样

```
把 DEV 和 SIT 的表单、视图、字段各同步一份，然后告诉我差异，再解释 Account 表单为什么会不一样。
```

```
d365_sync   environments=["dev","sit"] resources=["forms","views","solutions"] includeAttributes=true entities=["account"]
d365_diff   base=dev head=sit resources=["forms","views","attributes"]
d365_layers component=Account componentType=SystemForm allEnvironments=true
```

`d365_diff` 给机械差异（哪些行新增/删除/改字段），`d365_layers` 给原因（谁覆盖了它、谁在最上层）。

噪声已经处理过：时间戳与 `*id` 列不参与比较，`organization` 默认跳过。表单内容差异大时，报告里的字段级 diff 比整段 XML 可读得多。

---

## 4. 发布前评估一个解决方案

```
把 ContosoBase 从 DEV 发到 SIT 和 UAT，有什么风险？
```

```
d365_migrate action=assess source=dev solution=ContosoBase targets=["sit","uat"]
```

报告会回答：

- 目标有没有这个解决方案，源版本是不是更高；
- 每个组件在目标的最上层是谁，导入后哪些解决方案的定义会被压住（列出被遮蔽的解决方案，按组件数排序）；
- 选项集的值会不会丢（源有、目标没有的值 = 严重；标签不一致 = 警告）；
- 目标缺失的组件；
- 源是未受管时，导入后形成的层无法通过卸载解决方案清除。

真实案例：一个只含 1 个全局选项集的解决方案，评估结论可能是「0 严重、2 警告，但会让 7 个解决方案的定义失效」——真正要决策的不是丢不丢数据，而是**以后谁再导入一次 Contoso 的 patch，就会把这个层又盖回去**。

---

## 5. 检查一个 MR 能不能发到 UAT

```
https://gitlab.example.com/contoso/powerapps/-/merge_requests/7759/diffs 这个 MR 发到 UAT 会不会有问题？
```

```
d365_code_check mergeRequest="https://gitlab.example.com/contoso/powerapps/-/merge_requests/7759/diffs" targets=["uat"]
```

输出三段：

- **阻断**：字段不在任何引用该库的表单上、实体不存在、删除的函数仍被 Handler 引用、C# 类型/步骤/镜像缺失；
- **警告**：字段只在部分表单上、程序集版本没提升、硬编码 GUID；
- **人工确认**：配置数据、secure configuration、权限、列名与普通键的歧义。

报告在 `.d365/reports/code-check-<MR>-<时间戳>.md`。

纯 C# 的 MR 也能跑：按工程目录推断程序集 → 精确匹配 → 查类型/步骤/镜像/过滤属性。程序集名只做精确匹配，猜错比不查更糟。

---

## 6. 补一批选项值

```
contoso_taxcategoryos 还缺 36 个税号类型，按 .d365/reports 里的清单补到 DEV。
```

```
d365_write action=plan-add-options environment=dev optionSet=contoso_taxcategoryos \
  labels=["AD3|Andorra: Tax Register Number (NRT)", "..."]
```

计划返回操作列表（值从当前最大值 +1 顺延、已存在的代码进 skipped）。核对后：

```
执行 mw04aul6-1ci6aa
```

对话里弹卡片 → 批准 → 写入 → 只发布这个选项集。审计在 `.d365/changes/`，发布结果在 `.d365/changes/publish-<planId>.json`。

**其余环境不要重复手工追加**：随解决方案导入走，否则下次谁再导入受管 patch，手工加的层就被压掉了。

---

## 7. 上游改了插件，下游缺什么

```
DEV 的插件注册，SIT 和 UAT 都跟上了吗？顺便看下表单引用的脚本有没有缺。
```

```
d365_contract action=drift source=dev targets=["sit","uat"] forms=true
```

典型结果（真实数据）：86 条 = 程序集缺失 4、插件步骤缺失 72、类型缺失 8、表单库缺失 2。
`forms=false` 可跳过读 formxml；`handlers=true` 会下载脚本核对函数是否存在（慢，最多 400 个脚本/环境）。

确实允许的差异登记豁免：

```
d365_contract action=waive rule=form-library-missing env=sit \
  object="/_static/_common/scripts/CommandbarActions.js" reason="该环境不用 SLA 对话框" days=30
```

下次跑同一组 `source → targets`，会给出「新增 N / 已消失 M」的趋势。

---

## 8. 发布卡住了 / 现在能不能写

```
四个环境现在有正在跑的导入或发布吗？我想改点元数据。
```

```
d365_health allEnvironments=true
```

如果某个环境有正在进行的 `Publish` 或导入，任何写入都会 `0x80071151` 或等锁超时。等它结束再执行；`d365_write execute` 本身也会先查这一步，忙时直接拒绝而不是丢一个原始 429。

确认那条记录是残留（例如几天前中断的导入）时，才用 `force: true`。

---

## 9. 磁盘被产物撑大了

```
.d365 现在多大？哪些能清？
```

```
d365_reports action=list
d365_reports action=cleanup target=query            # 默认只预演
d365_reports action=cleanup target=query dryRun=false
d365_reports action=compact                         # 把快照 JSON 压成单行
```

真实数据：四份全量快照约 540 MB，压成单行省 68 MB；单份快照里 `plugin_steps.json` 约 55 MB、`solution_components.json` 约 39 MB、`web_resources.json` 约 20 MB。

保留策略与自动清理见 [tools.md](tools.md#d365_reports) 与根目录 README。

---

## 组合用法

| 想问 | 组合 |
| --- | --- |
| 改这个字段安全吗 | `d365_refs` + `d365_data` + `d365_layers` |
| 这个版本能发吗 | `d365_health` + `d365_migrate` + `d365_contract` |
| 这个 MR 能合吗 | `d365_code_check` + `d365_refs` |
| 环境之间差在哪 | `d365_sync` + `d365_diff` + `d365_layers` |
| 为什么运行时报错 | `d365_refs`（字段/脚本引用）+ `d365_layers`（谁覆盖）+ `d365_health`（作业） |
