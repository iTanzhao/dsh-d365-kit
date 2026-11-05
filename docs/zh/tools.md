# 工具参考

**[English](../en/tools.md)** | 简体中文

16 个工具，全部以 `d365_` 开头。返回一律是「摘要 + 文件路径」：正文太长时落文件，对话里只给结论与位置。

约定：

- **环境参数**：`environment`（单个）、`environments`（数组）、`allEnvironments`（全部）。省略时用配置的默认环境。
- **只读与写入**：只有 `d365_write execute`、`d365_data_write`、`d365_data_sync execute` 会改环境，且必须人在确认卡片上批准。
- **产物**：`<工作区>/.d365/`。返回里给的是**绝对路径**，可直接用文件工具打开。

---

## d365_envs

列出环境、凭据是否齐全。回答「某环境里有没有 X」之前先用它，避免把「没配置」误说成「环境里没有」。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `check` | boolean | false | 真实连接每个环境验证（消耗少量请求） |

```json
{ "check": true }
```

返回：每个环境的 key、显示名、URL、凭据来源（inline / secrets / env）、连通性与版本号。

---

## d365_configure

读写环境清单：与设置页「环境」是同一份数据。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `action` | `list` \| `save` \| `remove` \| `check` | 默认 `list` |
| `environment` | string | 环境 key；`save` / `remove` / `check` 必填 |
| `url` | string | `save`：环境 URL |
| `label` | string | `save`：显示名 |
| `cloud` | `public` \| `usgovernment` \| `dod` \| `china` | `save`：云，默认 `public` |
| `tenantId` | string | `save`：Entra 租户 ID |
| `clientId` | string | `save`：应用用户 ClientId |
| `clientSecret` | string | `save`：客户端密钥，写进 `d365.secrets.json` |
| `clearSecret` | boolean | `save`：清掉已保存的密钥 |
| `defaultEnvironment` | string | `save`：同时设为默认环境 |

```json
{ "action": "save", "environment": "sit", "url": "https://contoso-sit.crm5.dynamics.com",
  "tenantId": "<tenant-guid>", "clientId": "<client-id>", "clientSecret": "<secret>" }
```

注意：密钥是**明文**写入本机文件，不要把它粘进提交记录或截图。

---

## d365_metadata

按类别查元数据。19 类资源：

`organization`、`entities`、`attributes`、`keys`、`one_to_many_relationships`、`many_to_many_relationships`、
`forms`、`views`、`workflows`、`business_rules`、`plugin_assemblies`、`plugin_types`、`plugin_steps`、
`web_resources`、`solutions`、`solution_components`、`custom_apis`、`sitemaps`、`option_sets`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `resource` | enum（上表） | 必填 | 查哪一类 |
| `entity` | string | — | 实体逻辑名，用于 attributes / keys / relationships / forms / views / workflows 等 |
| `filter` | string | — | 额外的 OData `$filter`，不带 `$filter=`，如 `contains(name,'审批')` |
| `select` | string | — | 额外返回的列，逗号分隔；列名写错会自动降级重试 |
| `orderby` | string | — | 覆盖默认排序，如 `modifiedon desc` |
| `top` | integer | 配置 `maxRecords`（200） | 最多返回多少行 |
| `environments` | string[] | 默认环境 | 一次查多个环境并按名称对齐、给出跨环境差异 |
| `allEnvironments` | boolean | false | 全部环境 |
| `save` | boolean | false | 强制把完整结果写入文件（默认超过 12 行才写） |

```json
{ "resource": "attributes", "entity": "account", "filter": "startswith(logicalname,'contoso_')", "top": 20 }
```

几个真实约束：

- 元数据端点（`EntityDefinitions`）**不接受** `$orderby` 与 `$top`，客户端会逐步降级重试；
- 显示名有多语言，跨环境比较请用**逻辑名**，不要用显示名；
- 实体集名可被自定义，不要硬编码复数形式，用 `entities` 资源或 `d365_data` 的自动解析；
- `workflows` / `business_rules` 默认只取**定义行**（`type eq 1`）：Dataverse 给每个流程另存一条同名、不同 `workflowid` 的激活行（`type eq 2`），不过滤会看起来像重复、计数也会翻倍；显式传 `filter`（如 `type eq 2`）时默认过滤自动让位，不会 AND 成空集。

---

## d365_layers

查 `msdyn_componentlayer`：组件被哪些解决方案覆盖过、层顺序、谁生效。

`msdyn_componentlayer` 是虚拟实体（自定义数据提供程序）：**必须同时给组件 id 和组件类型**。只给名字、只给 id、什么都不给都会返回 0 行（不报错）。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `component` | string | 组件名或 GUID。Entity 用逻辑名；其它类型用该类记录的名称/唯一名 |
| `componentType` | enum | `Entity`、`Attribute`、`SystemForm`、`SavedQuery`、`Workflow`、`WebResource`、`PluginAssembly`、`PluginType`、`SdkMessageProcessingStep`、`CustomAPI` |
| `entity` | string | `componentType=Attribute` 时必填 |
| `solution` | string | 只看某个解决方案的层（结果内过滤） |
| `includeJson` | boolean | 同时取 `msdyn_componentjson`（完整定义，可能很大，写文件） |
| `top` | integer | 最多取多少条，默认 500 |
| `environments` / `allEnvironments` | | 跨环境对比活动层 |

```json
{ "component": "account", "componentType": "Entity", "allEnvironments": true }
{ "componentType": "Attribute", "component": "name", "entity": "account" }
{ "componentType": "SystemForm", "component": "Account" }
```

返回按 `msdyn_order` 升序，最后一层是当前生效层；`（系统层）` 表示该层不来自任何解决方案。

多环境查询时，某个环境没有该组件（按名称找不到）只会让**该环境**报「该环境没有这个组件」，其它环境照常返回并参与对比；全部环境都找不到才报错。

已知限制：部分环境里该表能读但返回 0 行，需要管理员身份才看得到数据。

---

## d365_sync

把环境元数据拉成本地快照。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `environments` | string[] | 默认环境 | 要同步的环境 |
| `allEnvironments` | boolean | false | 全部环境 |
| `resources` | enum[] | 一组核心资源（不含 attributes） | 只同步指定资源 |
| `includeAttributes` | boolean | false | 额外拉每个实体的字段定义（请求数≈实体数） |
| `entities` | string[] | — | 配合 `includeAttributes` 只拉这些实体 |
| `maxRecords` | integer | 0 = 全量 | 每个资源最多拉多少行；被截断会在 manifest 标出 |
| `keep` | integer | 配置 `snapshotKeep`（2） | 每个环境保留几份，超出删最旧 |

```json
{ "environments": ["dev", "sit"], "includeAttributes": true,
  "entities": ["account", "contact", "contoso_order"] }
```

产物 `<工作区>/.d365/snapshots/<env>/<快照ID>/`：

```
manifest.json     # 完成度：每资源 count / truncated / error
entities.json
solutions.json
attributes.json   # 仅 includeAttributes 时
...
```

manifest 是区分「环境里没有」与「没采到」的唯一依据。全量快照约 125 MB、三分钟；默认每环境留 2 份。

同步结束后会自动按保留策略清理，并压缩成单行 JSON。

---

## d365_diff

两份快照的字段级差异。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `base` | string | 基准快照：`dev`（最新）、`dev@prev`（上一份）、`dev@20261102T071005Z`（指定） |
| `head` | string | 对照快照，写法同上 |
| `resources` | string[] | 只比较这些资源 |
| `maxDetails` | integer | 每个资源在回复里最多列多少条，默认 30；完整清单写报告 |

```json
{ "base": "dev", "head": "sit", "resources": ["forms", "views", "attributes"] }
```

时间后缀可简写：`sit@082604` 会匹配 `20261102T082604Z`。

噪声治理：忽略时间戳与所有 `*id` 列（`NOISE_FIELDS`），默认跳过 `organization`（环境身份）。报告在 `.d365/diffs/`；快照超过 24 小时会在报告里提示先重新同步。

---

## d365_refs

反查引用：「我要改/删的这个东西，谁在用」。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `kind` | `field` \| `web_resource` \| `plugin_assembly` | 必填 |
| `entity` | string | `kind=field` 必填 |
| `attribute` | string | `kind=field` 必填 |
| `name` | string | `kind=web_resource` 填资源名；`kind=plugin_assembly` 填程序集名 |
| `environment` / `environments` / `allEnvironments` | | 可跨环境 |

```json
{ "kind": "field", "entity": "account", "attribute": "contoso_customertier", "environments": ["dev", "sit"] }
{ "kind": "web_resource", "name": "contoso_/scripts/account_form.js" }
{ "kind": "plugin_assembly", "name": "Contoso.Customizations" }
```

| kind | 返回 |
| --- | --- |
| `field` | 哪些表单放了该字段（隐藏的单独标出）、哪些视图在列/筛选中用它、哪些流程与业务规则引用 |
| `web_resource` | 哪些表单加载这个库、绑了哪些事件与处理函数 |
| `plugin_assembly` | 版本、注册类型数、每个类型的步骤（消息、实体、stage、过滤属性、rank） |

实现是服务端 `contains()` 过滤（`formxml` / `layoutxml` / `fetchxml`），不用把整个组织拉到本地。完整结果在 `.d365/query/`。

限制：快速查看表单里引用其它实体字段的情况不在范围内；流程/业务规则是文本匹配，动态拼接的字段名可能漏判。

---

## d365_data

读业务记录。**默认关闭**：没有在设置页给该环境勾「读取业务数据」（`data.read`），任何非元数据表都会在取令牌前被拒。元数据本身由「读取元数据」（`metadata.read`）控制，默认开启。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `action` | `count` \| `group` \| `sample` | 必填 |
| `entity` | string | 必填。逻辑名或集合名（`contoso_systemconfiguration` / `contoso_systemconfigurations`） |
| `filter` | string | OData `$filter`，不带 `$filter=` |
| `field` | string | `group` 必填：按哪列分组 |
| `select` | string | `sample` 返回的列，逗号分隔 |
| `top` | integer | `sample` 行数（默认 5，最多 100）；`group` 返回前 N 组（默认 20） |
| `environment` / `environments` / `allEnvironments` | | 环境选择 |

```json
{ "action": "count", "entity": "contoso_systemconfiguration", "filter": "statecode eq 0" }
{ "action": "group", "entity": "account", "field": "contoso_customertier" }
{ "action": "sample", "entity": "account", "select": "name,contoso_customertier", "top": 5 }
```

计数优先 `$apply=aggregate($count as count)`（不受 `$count=true` 的 5000 上限影响），失败退 `$count=true`；空分组显示「（空）」。

用途：改选项集、删字段、收窄筛选条件之前，先知道「这个值还有多少条记录在用」。

---

## d365_data_write

新建或修改**一条**业务记录，用于补配置数据这类场景。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `action` | `create` \| `update` | 必填 |
| `entity` | string | 必填，逻辑名或集合名 |
| `id` | string | `update` 必填：主键 GUID |
| `values` | object | 必填：字段逻辑名 → 值；`null` 表示清空 |
| `environment` | string | 单环境，不会跨环境批量写 |

```json
{ "action": "create", "entity": "contoso_systemconfiguration",
  "values": { "contoso_key": "FEATURE_X", "contoso_value": "1" } }
```

约束：

- 需要该环境授权 `data.write`（默认关闭）；
- 每次写入弹确认卡片（环境、表、字段名与值；值截断 120 字符、最多 20 个字段）；
- `create` 带 `Prefer: return=representation`，`update` 带 `If-Match: *`；
- 审计写 `.d365/query/<时间戳>-data-write-<action>.json`，**只记字段名、不落值**；
- 不能删记录。

---

## d365_data_sync

把一个环境的业务记录搬到另一个环境。默认**镜像**（源 GUID 即目标 GUID）：先 `plan` 只读预演，报告数据量、字段、lookup 情况、冲突、**权限是否开启**、是否 Bypass 插件，并列出「迁移条件、迁移字段、Bypass」三项等你确认；人确认后 `execute` 才写入。

| `action` | 作用 |
| --- | --- |
| `plan` | 生成只读计划并落文件，不写任何东西（默认） |
| `show` / `list` / `cancel` | 重看 / 列出 / 取消待执行计划 |
| `execute` | 弹确认卡片，批准后才写入 |

迁移前先定三件事（预演结果里会逐条列出，要改就重新 `plan`）：

1. **迁移条件**：`since`（时间窗口；`mode=new` 按 createdon、`mode=modified` 按 modifiedon）、`filter`（OData `$filter`）、`ids`、`fetchXml` 任选；都不给就是**整表**（默认全部）。整表且数据量大时，预演会在「需要注意」里建议用 `since` / `filter` 缩小范围，并用 `maxRecords` 限制本次读多少条。
2. **迁移字段**：`fields` 不给就是**全部可写字段**。字段清单里**含主键**（`xxxid`）就等于保持 GUID 一致；**不含主键**时目标重新分配 GUID。（也可以用 `keepGuid` 显式覆盖。）
3. **Bypass 自定义插件**：默认**跳过**（`bypassPlugins: true`，写请求带 `MSCRM.BypassCustomPluginExecution`，目标环境的同步插件不跑，避免触发下游通知/集成）。要照常跑插件就传 `bypassPlugins: false`。

```json
{ "action": "plan", "source": "dev", "target": "sit",
  "entity": "account", "since": "2026-11-05T00:00:00+08:00", "maxRecords": 200 }
```

约束与行为：

- **保持 GUID**：跟着字段走（见上）；`keepGuid: false` 时由目标分配主键，批内引用按依赖顺序重映射，创建后二次 `PATCH` 补齐（环上的引用也走这一步）。
- **lookup 解析顺序**：先按 GUID 在目标找同一条；找不到再按主名精确匹配（命中 1 条记「按名称」，多条记「歧义」，0 条记「缺失」）。多态 lookup（`customerid` 这类）先在源环境确定它指向哪张表，不靠猜。
- **冲突**：目标已存在同 GUID 时默认只报告不写；`conflict: "overwrite"` 才逐条 `PATCH`。
- **缺失引用**：默认这些记录不写并在报告里列出；`onMissingLookup: "null"` 清空该引用，`"fail"` 让整个计划拒绝执行。
- **写入选项**：`overriddencreatedon` 保留创建时间；默认带 `MSCRM.SuppressDuplicateDetection`；Bypass 默认开（确认卡片上会写明）。
- **权限**：`plan` 要求源和目标都有 `data.read`；`execute` 还要求目标有 `data.write`。预演的「权限（execute 需要）」段会直接告诉你目标环境还缺哪一项——缺 `data.write` 时 `execute` 会被拦下，先去设置页「权限」勾上。
- **落地**：计划在 `.d365/data-sync/plans`，执行记录在 `.d365/data-sync/runs`（含每条源 GUID → 目标 GUID 与失败原因）。
- 只新增/修改，**不删记录**；不搬审计字段（createdby/modifiedby 等），owner 按 `ownerMode`（`map` / `keep` / `caller`）处理。

---

## d365_write

元数据变更。**`plan-*` 只读**，生成计划；`execute` 在对话里弹确认卡片后才写入。

| `action` | 需要的参数 | 作用 |
| --- | --- | --- |
| `policy` | — | 看各环境已授权的能力 |
| `plan-add-options` | `optionSet` 或 `entity`+`attribute`、`labels` | 新增选项值；代码按 `\|` 前部分去重，值从当前最大值 +1 顺延 |
| `plan-relabel` | `optionSet` 或 `entity`+`attribute`、`updates` | 改选项标签 |
| `plan-option-delete` | 同上、`values`、`acknowledge: true` | 删除选项值（高危） |
| `plan-add-attribute` | `entity`、`schemaName` | 新增字段，类型见下 |
| `plan-update-attribute` | `entity`、`attribute`、要改的项 | 改显示名 / 描述 / 必填级别 |
| `plan-delete-attribute` | `entity`、`attribute`、`acknowledge: true` | 删除字段（高危） |
| `plan-update-entity` | `entity`、`displayName` | 改表显示名与描述 |
| `plan-view-columns` | `view`、`addColumns` / `removeColumns` | 增删系统视图的列 |
| `plan-remove-layer` | `component`、`componentType`（Entity/Attribute）、`acknowledge: true` | 移除组件最上面的未受管自定义层（高危） |
| `list` | — | 列待确认计划 |
| `execute` | `planId` | 弹确认卡片，批准后执行 |
| `cancel` | `planId` | 取消待确认计划 |

公共参数：

| 参数 | 说明 |
| --- | --- |
| `environment` | 目标环境 key |
| `solutionUniqueName` | 承载改动的**未受管**解决方案唯一名；省略用设置页的默认值。名字不存在或受管会直接报错 |
| `rationale` | 变更理由，写进计划与变更记录 |
| `force` | `execute`：跳过「环境正在发布/导入」检查，只用于确认那条记录是残留 |

`plan-add-attribute` 的类型与参数：

| `fieldType` | 额外参数 | 默认 |
| --- | --- | --- |
| `string` | `maxLength` | 100 |
| `memo` | `maxLength` | 2000 |
| `integer` | — | — |
| `decimal` | `precision` | 2 |
| `money` | `precision` | 2 |
| `boolean` | — | True/False 标签 |
| `datetime` | — | 日期+时间 |

`requiredLevel`：`None` / `Recommended` / `Required`；`language` 默认 1033（中文环境用 2052）。

```json
{ "action": "plan-add-options", "environment": "dev", "optionSet": "contoso_taxcategoryos",
  "labels": ["AD3|Andorra: Tax Register Number (NRT)", "AE1|UAE: TRN"] }
```

```json
{ "action": "plan-add-attribute", "environment": "dev", "entity": "account",
  "schemaName": "contoso_CustomerTier", "fieldType": "string", "maxLength": 120,
  "displayName": "客户等级", "requiredLevel": "None" }
```

```json
{ "action": "execute", "planId": "mw04aul6-1ci6aa" }
```

`plan-remove-layer` 只删**最上面那一层、且必须显示为 `Active`**（未受管的自定义层），删完由下面那层重新生效：

| 参数 | 说明 |
| --- | --- |
| `componentType` | `Entity`（表）或 `Attribute`（字段），默认 `Entity` |
| `component` | 表逻辑名；`Attribute` 时是字段逻辑名 |
| `entity` | `componentType: Attribute` 时必填：字段所属的表 |

计划会写出层栈、被删的层、以及之后生效的是哪一层（没有下层就是「系统定义」）。最上层若不是 `Active` 会直接拒绝：那种层属于某个解决方案，要在解决方案里移除组件，或导入一个新 patch 覆盖它。删层不可恢复，执行后按受影响的表发布。

写入细节、确认卡片、发布范围见 [permissions.md](permissions.md)。

---

## d365_migrate

评估把某个解决方案发布到其它环境的迁移风险。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `action` | `assess` | `assess` | 目前只有评估 |
| `source` | string | 默认环境 | 源环境 |
| `solution` | string | 必填 | 解决方案唯一名 |
| `targets` | string[] | 除源外全部 | 目标环境 |
| `maxComponents` | integer | 150 | 最多评估多少组件 |
| `full` | boolean | false | 评估全部组件（忽略 `maxComponents`） |
| `concurrency` | integer | 4，上限 8 | 并发请求数 |

```json
{ "action": "assess", "source": "dev", "solution": "ContosoBase", "targets": ["sit"] }
```

结论分三类：数据风险（选项值丢失、标签漂移）、遮蔽（目标层最上层是谁、导入后压住哪些解决方案）、缺失与版本。

报告：`.d365/reports/migration-<方案>-to-<目标>-<时间戳>.md` + `.json`。规则细节见 [checks.md](checks.md)。

---

## d365_contract

契约矩阵与漂移：把上游的插件注册与表单引用当成契约，检查下游是否还在履行。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `action` | `drift` \| `matrix` \| `waive` \| `waivers` | `drift` | |
| `source` | string | 默认环境 | 上游 |
| `targets` | string[] | 除上游外全部 | 下游 |
| `optionSets` | string[] | — | 要逐值比对的全局选项集 |
| `includeManaged` | boolean | false | 连受管程序集一起比（噪声大） |
| `forms` | boolean | true | 检查表单引用的 Web 资源与站点地图 |
| `handlers` | boolean | false | 下载脚本核对 Handler 函数是否存在（慢） |
| `rule` / `env` / `object` / `reason` / `days` | | | `waive` 用：规则、环境、对象、理由、过期天数（默认 30） |

```json
{ "action": "drift", "source": "dev", "targets": ["sit", "uat"], "forms": false }
```

```json
{ "action": "waive", "rule": "form-library-missing", "env": "sit",
  "object": "/_static/_common/scripts/CommandbarActions.js", "reason": "该环境不用 SLA 对话框", "days": 30 }
```

规则表、豁免与趋势见 [checks.md](checks.md)。报告在 `.d365/reports/contract-*.md|json`。

---

## d365_health

环境健康：「现在动这个环境安全吗」。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `environments` | string[] | 默认环境 | |
| `allEnvironments` | boolean | false | |
| `hours` | integer | 24 | 失败作业回看小时数 |

```json
{ "allEnvironments": true, "hours": 24 }
```

每环境给出：版本、组织名、排队中（Ready）、挂起作业数（Suspended）、近期失败数（按作业名合并）、正在导入/发布的解决方案、最近安装的解决方案。

失败判定用的是 `statecode 3`（Completed）**且** `statuscode 31`（Failed）：同一个 Completed 下还有 30 Succeeded、32 Canceled，只看 `statecode` 会把成功的作业算成失败，也会把成功的作业列进失败清单。

同一份「正在导入/发布」判定也被写入前的预检查复用。

---

## d365_reports

本机产物与占用。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `action` | `list` \| `cleanup` \| `compact` | `list` | |
| `target` | `snapshots` \| `reports` \| `diffs` \| `query` \| `changes` \| `all` | `all` | `cleanup` 的范围 |
| `dryRun` | boolean | **true** | 只预演；确认后传 `false` 才删 |
| `limit` | integer | 15 | `list` 每类列多少条 |

```json
{ "action": "cleanup", "target": "query" }
{ "action": "cleanup", "target": "query", "dryRun": false }
{ "action": "compact" }
```

清理只碰 `.d365/` 下的已知子目录，删前逐个校验路径前缀；`waivers.json`、`pending-writes/`、配置文件永不被删。

---

## d365_code_check

读一次 GitLab MR，检查改动在目标环境会不会跑不起来。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `mergeRequest` | string | 必填。MR 链接或 IID（`42` / `!42`） |
| `project` | string | `group/project`；省略时用链接里的项目，再省略用设置页默认项目 |
| `targets` | string[] | 要对照的环境；省略则全部 |

```json
{ "mergeRequest": "https://gitlab.example.com/contoso/powerapps/-/merge_requests/7759/diffs",
  "targets": ["uat"] }
```

需要先在设置页「GitLab」填地址与只读令牌（`read_api`）；令牌所在用户至少 Reporter 角色。

输出三段：阻断、警告、人工确认。报告在 `.d365/reports/code-check-<MR>-<时间戳>.md`。规则细节见 [checks.md](checks.md)。
