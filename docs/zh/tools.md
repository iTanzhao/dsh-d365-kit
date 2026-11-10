# 工具参考

**[English](../en/tools.md)** | 简体中文

19 个工具，全部以 `d365_` 开头。返回一律是「摘要 + 文件路径」：正文太长时落文件，对话里只给结论与位置。

约定：

- **环境参数**：`environment`（单个）、`environments`（数组）、`allEnvironments`（全部）。省略时用配置的默认环境。
- **只读与写入**：只有 `d365_write execute`、`d365_data_write`、`d365_data_sync execute`、`d365_invoke`（POST）会改环境，且必须人在确认卡片上批准。
- **产物**：`<工作区>/.d365/`。返回里给的是**绝对路径**，可直接用文件工具打开。

## 按问题查

| 你手上是这个问题 | 用这个 | 不要用 |
| --- | --- | --- |
| 这个环境里到底有什么、版本多少 | `d365_envs`（`check` 真连） | 直接猜 URL |
| 这张表有哪些字段、某个字段的类型/默认值 | `d365_metadata resource=attributes`（派生列先用 `cast`） | `d365_data` |
| 这个字段为什么在表单上没有 / 改了不生效 | `d365_refs kind=field`（谁在用）+ `d365_layers`（谁覆盖） | 只看 `attributes` |
| 两个环境差在哪 | `d365_sync` 两边各拉一份 → `d365_diff` | 两边各查一遍对眼 |
| 目标环境缺哪个程序集、类型、步骤 | `d365_contract drift`（含版本更旧、表单库、站点地图） | 翻 `plugin_steps` 5000 行 |
| 这个表 / 这个选项集被哪些解决方案盖过 | `d365_layers` | `d365_metadata solutions` |
| 组件在不在目标环境、导入会不会覆盖别人的层 | `d365_migrate` | `d365_diff` |
| 把 DEV 的一批记录复制到 SIT | `d365_data_sync plan` → `execute`（保持 GUID、lookup 解析、确认卡） | `d365_data_write` 逐条手抄 |
| 改一批已存在记录的某个字段 | `d365_data_sync plan-update` → `execute` | `d365_data_write` 一条一张卡 |
| 改一条记录 / 新建一条 | `d365_data_write` | `d365_write` |
| 改元数据：加字段、改显示名、加选项值、移除自定义层 | `d365_write`（`plan-*` 只读，`execute` 确认） | 手写 Web API |
| 这条记录长什么样、有多少条 | `d365_data`（`count` / `group` / `sample` / `query`） | `d365_metadata` |
| 插件报错了，为什么 | `d365_trace summary` → `get`；先 `d365_health` 排除异步作业 | 猜错误码 |
| 这条表的逻辑是不是在云流里 / 哪些 flow 会碰这张表 | `d365_flows refs` → `show` | 在 Power Automate 门户里逐条点开 |
| 这条消息现在返回什么 | `d365_invoke`（GET 走 data.read，POST 走 message.invoke 且每次确认） | Postman 手拼 |
| 这个 MR 会不会跑不起来 | `d365_code_check` | 肉眼看 diff |
| 产物太大，对话里看不全 | `d365_reports action=view`（`match` 找一条 GUID） | 让文件工具全量读 |

不传条件时 `d365_data_sync` 按整表预演并提示；`d365_data` 的 `sample` 最多 100 行、`group` 最多 500 组，要更多用 `query` 配 `top`。

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

按类别查元数据。20 类资源：

`organization`、`entities`、`attributes`、`keys`、`one_to_many_relationships`、`many_to_many_relationships`、
`forms`、`views`、`workflows`、`business_rules`、`plugin_assemblies`、`plugin_types`、`plugin_steps`、`step_images`、
`web_resources`、`solutions`、`solution_components`、`custom_apis`、`sitemaps`、`option_sets`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `resource` | enum（上表） | 必填 | 查哪一类 |
| `entity` | string | — | 实体逻辑名，用于 attributes / keys / relationships / forms / views / workflows 等 |
| `name` | string | — | 按名称精确取一条（目前只有 `option_sets`：走 keyed read，一次请求取一个全局选项集，不用把 900 多个定义全拉下来） |
| `attribute` | string | — | `attributes` 资源只取一个字段（主键读取）。配合 `cast` 读派生类型才有的列 |
| `cast` | string | — | 把字段 cast 到派生元数据类型，如 `BooleanAttributeMetadata`、`PicklistAttributeMetadata`、`LookupAttributeMetadata`、`StringAttributeMetadata`。只和 `attribute` 一起用 |
| `expand` | string | — | 额外的 `$expand`，如 `plugintypeid($select=typename)`；`plugin_steps` 默认已展开插件类型与消息名 |
| `filter` | string | — | 额外的 OData `$filter`，不带 `$filter=`，如 `contains(name,'审批')` |
| `select` | string | — | 额外返回的列，逗号分隔；列名写错会自动降级重试。**显式 select 会决定摘要表格显示哪些列** |
| `orderby` | string | — | 覆盖默认排序，如 `modifiedon desc` |
| `top` | integer | 清单型资源 1000，其它配置 `maxRecords`（200） | 最多返回多少行 |
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
- `option_sets`（`GlobalOptionSetDefinitions`）**不接受** `$filter`（服务端直接返回 HTTP 405：`The query parameter $filter is not supported`），所以 `filter` 会被当场拒绝并提示改用 `name`。按名称取是 keyed read，找不到返回 404，工具会报「该环境没有名为 X 的全局选项集定义」而不是空表。
- 要一次看全部 987 个定义、或要选项值时：全量用不带 `filter`/`name` 的查询；单个定义的选项值目前要用 cast 路径（`GlobalOptionSetDefinitions(<id>)/Microsoft.Dynamics.CRM.OptionSetMetadata?$select=Options`），工具暂未封装。
- 清单型资源（`plugin_steps`、`plugin_types`、`step_images`、`attributes`）默认上限是 1000，不是 200：成熟组织的 `sdkmessageprocessingsteps` 常在 5000 条以上，200 行 + 按名称排序会让要找的步骤「看起来不存在」。结果被截断时摘要会写「已列 N 条 / 共 M 条（M 为服务端 `$count`，上限 5000 显示为 ≥5000）」，不是静默截断。
- 派生类型才有的列要先 cast：`DefaultValue`、`OptionSet`、`Targets`、`Format` 这些不在 `AttributeMetadata` 基类型上。单字段读取用 `{"resource":"attributes","entity":"account","attribute":"donotemail","cast":"BooleanAttributeMetadata","select":"LogicalName,DefaultValue"}`；不带 cast 却 select 这些列会得到 400。
- `plugin_steps` 默认 `$expand=plugintypeid($select=typename),sdkmessageid($select=name)`，摘要里的 `plugintype` / `message` 列就是这么来的（步骤的 `name` 经常是空的，靠这两列才认得出是哪一步）；要镜像（Step Image）用 `step_images` 资源。

---

## d365_layers

查 `msdyn_componentlayer`：组件被哪些解决方案覆盖过、层顺序、谁生效。

`msdyn_componentlayer` 是虚拟实体（自定义数据提供程序）：**必须同时给组件 id 和组件类型**。只给名字、只给 id、什么都不给都会返回 0 行（不报错）。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `component` | string | 组件名或 GUID。Entity 用逻辑名；其它类型用该类记录的名称/唯一名；`OptionSet` 用全局选项集名称 |
| `componentType` | enum | `Entity`、`Attribute`、`SystemForm`、`SavedQuery`、`Workflow`、`WebResource`、`PluginAssembly`、`PluginType`、`SdkMessageProcessingStep`、`CustomAPI`、`OptionSet` |
| `entity` | string | `componentType=Attribute` 时必填 |
| `solution` | string | 只看某个解决方案的层（服务端过滤，不会因为层数超过 `top` 而误报「没有层」） |
| `includeJson` | boolean | 同时取 `msdyn_componentjson`（完整定义，可能很大，写文件） |
| `top` | integer | 最多取多少条，默认 500 |
| `environments` / `allEnvironments` | | 跨环境对比活动层 |

```json
{ "component": "account", "componentType": "Entity", "allEnvironments": true }
{ "componentType": "Attribute", "component": "name", "entity": "account" }
{ "componentType": "SystemForm", "component": "Account" }
{ "componentType": "OptionSet", "component": "contoso_taxcategoryos", "allEnvironments": true }
```

返回按 `msdyn_order` 升序，最后一层是当前生效层；`（系统层）` 表示该层不来自任何解决方案。

`Active` 是 Dataverse 给**未受管的自定义层**用的伪解决方案名：它存在时永远在最上面，盖住下面的受管层，也是唯一可以用 `d365_write plan-remove-layer` 删掉的一层。因此输出里会标成 `Active（未受管）`，并单独说明「最上层是未受管层」还是「该环境没有未受管层」——后者表示这个组件在这里完全跟着解决方案走。Active 层的 `msdyn_overwritetime` 恒为 `1900-01-01`（服务端不记录），更新时间显示为「不记录」而不是一个假的日期。

`OptionSet` 只解析**全局**选项集（走 `GlobalOptionSetDefinitions(Name='…')` 取 `MetadataId`）；本地选项集随字段存在，用 `componentType=Attribute` + `entity` 查字段的层。选项集也可以删层（`d365_write plan-remove-layer`，`componentType: OptionSet`）。

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

`attributes`、`keys`、`one_to_many_relationships`、`many_to_many_relationships` 是按实体取的资源：没传 `entities` 时会被跳过并在「问题」里写明（以前会拼出 `LogicalName='undefined'` 直接报错）。

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

`solution_components` 例外：组件的 `objectid` 是按组织分配的 GUID，逐行对齐跨环境只会得到「全部新增 + 全部删除」。这个资源改为按 `componenttype` **计数**比较（`~ componenttype 1：数量 11469→10754`），报告里会写明。要定位具体哪个组件，用 `d365_migrate` 或 `d365_layers`。

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
| `action` | `count` \| `group` \| `sample` \| `query` | 必填 |
| `entity` | string | 必填。逻辑名或集合名（`contoso_systemconfiguration` / `contoso_systemconfigurations`） |
| `filter` | string | OData `$filter`，不带 `$filter=` |
| `field` | string | `group` 必填：按哪列分组 |
| `select` | string | `sample` / `query` 返回的列，逗号分隔；`query` 省略则取行本身带的列 |
| `orderby` | string | `query` 的排序，例如 `modifiedon desc` |
| `expand` | string | `query` 的 `$expand`，例如 `primarycontactid($select=fullname)` |
| `id` | string | `query`：按主键取一条（GUID，或带引号的备用键值如 `'contoso_001'`） |
| `top` | integer | `sample` 行数（默认 5，最多 100）；`group` 返回前 N 组（默认 20）；`query` 返回行数（默认 25，最多 500） |
| `environment` / `environments` / `allEnvironments` | | 环境选择 |

```json
{ "action": "count", "entity": "contoso_systemconfiguration", "filter": "statecode eq 0" }
{ "action": "group", "entity": "account", "field": "contoso_customertier" }
{ "action": "sample", "entity": "account", "select": "name,contoso_customertier", "top": 5 }
{ "action": "query", "entity": "account", "select": "name,createdon", "orderby": "createdon desc", "top": 3 }
{ "action": "query", "entity": "accounts", "id": "11111111-1111-1111-1111-111111111111" }
```

计数优先 `$apply=aggregate($count as count)`（不受 `$count=true` 的 5000 上限影响），失败退 `$count=true`；空分组显示「（空）」。

`query` 的标题会区分三种情况：`共 N 行`、`已列 N 条 / 共 M 条（未列全…）`、`返回 N 行（可能还有更多）`。**跨环境复制的 GUID 在目标环境不存在时是 404**，`id` 分支会明确报 `record-not-found`，而不是给一张空表。

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
| `plan-update` | 生成**批量更新**计划（同一环境、按显式 id 清单改字段），不写任何东西 |
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
- **lookup 写入按导航属性名**：`@odata.bind` 的键是关系的导航属性名，不一定是字段逻辑名（自定义关系里 `contoso_approverid` 常绑到 `contoso_ApproverId`）。预演会从 `RelationshipDefinitions` 读这张映射，报告里单列「导航属性名与逻辑名不同」的字段；读不到时退回逻辑名，并在「需要注意」里提示。旧版本生成的计划没有这份映射，`execute` 会以 `stale-plan` 拒绝，重新 `plan` 即可。
- **冲突**：目标已存在同 GUID 时默认只报告不写；`conflict: "overwrite"` 才逐条 `PATCH`。
- **缺失引用**：默认这些记录不写并在报告里列出；`onMissingLookup: "null"` 清空该引用，`"fail"` 让整个计划拒绝执行。
- **写入选项**：`overriddencreatedon` 保留创建时间；默认带 `MSCRM.SuppressDuplicateDetection`；Bypass 默认开（确认卡片上会写明）。
- **权限**：`plan` 要求源和目标都有 `data.read`；`execute` 还要求目标有 `data.write`。预演的「权限（execute 需要）」段会直接告诉你目标环境还缺哪一项——缺 `data.write` 时 `execute` 会被拦下，先去设置页「权限」勾上。
- **落地**：计划在 `.d365/data-sync/plans`，执行记录在 `.d365/data-sync/runs`（含每条源 GUID → 目标 GUID 与失败原因）。
- 只新增/修改，**不删记录**；不搬审计字段（createdby/modifiedby 等），owner 按 `ownerMode`（`map` / `keep` / `caller`）处理。

### 批量更新（`plan-update`，同一环境）

改一个环境里已经存在的多条记录，不涉及跨环境。形态和迁移一样是两段式：`plan-update` 只读预演，`execute` 弹卡片批准。

```json
{ "action": "plan-update", "environment": "dev", "entity": "account",
  "ids": ["22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333"],
  "values": { "donotemail": true }, "rationale": "关闭这几个测试账号的邮件" }
```

| 参数 | 说明 |
| --- | --- |
| `environment` | 在哪个环境改（必填，批量更新只改一个环境） |
| `ids` | 待改记录的主键，**必须显式给出**（去重，上限 1000 条） |
| `values` | 字段逻辑名 → 新值；只支持标量字段 |

约束与行为：

- **不接受 `filter` / `fetchXml`**：改错一批记录没有撤销键。先用 `d365_data action=query` 查出 id，再传进来。
- **只支持标量字段**：lookup 需要按导航属性名绑定，用 `d365_data_write` 单条改更可靠；传 lookup 会以 `lookup-unsupported` 拒绝。
- 预演会读出现有值做 **before → after** 预览（前 5 条），列出找不到的 id、写入选项（Bypass / 抑制重复检测 / 并发），并列出「记录范围、更新字段、Bypass」三项等你确认。
- **权限**：`plan-update` 要求该环境有 `data.read`（要读现有值）；`execute` 还要求 `data.write`，且人在确认卡片上批准。
- 执行记录在 `.d365/data-sync/runs`（含每条 id 与失败原因）；同样**只改不删**。

---

## d365_write

元数据变更。**`plan-*` 只读**，生成计划；`execute` 在对话里弹确认卡片后才写入。

| `action` | 需要的参数 | 作用 |
| --- | --- | --- |
| `policy` | — | 看各环境已授权的能力 |
| `plan-add-options` | `optionSet` 或 `entity`+`attribute`、`labels` | 新增选项值；代码按 `\|` 前部分去重，值从当前最大值 +1 顺延。标签语言取 `language`（默认 1033） |
| `plan-relabel` | `optionSet` 或 `entity`+`attribute`、`updates` | 改选项标签。只改 `language` 那一种语言，`MSCRM.MergeLabels: true` 保留其它语言已有标签 |
| `plan-option-delete` | 同上、`values`、`acknowledge: true` | 删除选项值（高危） |
| `plan-add-attribute` | `entity`、`schemaName` | 新增字段，类型见下 |
| `plan-update-attribute` | `entity`、`attribute`、要改的项 | 改显示名 / 描述 / 必填级别 |
| `plan-delete-attribute` | `entity`、`attribute`、`acknowledge: true` | 删除字段（高危） |
| `plan-update-entity` | `entity`、`displayName` | 改表显示名与描述 |
| `plan-view-columns` | `view`、`addColumns` / `removeColumns` | 增删系统视图的列 |
| `plan-remove-layer` | `component`、`componentType`（11 类，见本节末）、`acknowledge: true` | 移除组件最上面的未受管自定义层（高危） |
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

`plan-remove-layer` 只删**最上面那一层、且必须显示为 `Active`**（未受管的自定义层），删完由下面那层重新生效。支持 `d365_layers` 认识的全部组件类型：

| `componentType` | `component` 取什么 | 执行后发布范围 |
| --- | --- | --- |
| `Entity`（默认） | 表逻辑名 | 该表 |
| `Attribute` | 字段逻辑名（配 `entity`） | 该表 |
| `OptionSet` | 全局选项集名称 | 该选项集 |
| `SystemForm` | 表单名称 | 表单所属的表（不归属任何表时不指定） |
| `SavedQuery` | 视图名称 | 视图所属的表 |
| `Workflow` | 流程名称 | 全量发布 |
| `WebResource` | Web 资源名称 | 全量发布 |
| `PluginAssembly` | 程序集名称 | 全量发布 |
| `PluginType` | 类型全名 | 全量发布 |
| `SdkMessageProcessingStep` | 步骤名称 | 全量发布 |
| `CustomAPI` | 唯一名 | 全量发布 |

| 参数 | 说明 |
| --- | --- |
| `componentType` | 见上表，默认 `Entity` |
| `component` | 见上表 |
| `entity` | `componentType: Attribute` 时必填：字段所属的表 |

计划会写出层栈、被删的层、以及之后生效的是哪一层（没有下层就是「系统定义」）。最上层若不是 `Active` 会直接拒绝：那种层属于某个解决方案，要在解决方案里移除组件，或导入一个新 patch 覆盖它。删层不可恢复，执行后按上表的范围发布——只有能确定归属时才发布单张表，其余走全量发布（慢一点但不会漏）。

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

每环境给出：版本、组织名、排队中（Ready）、挂起作业数（Suspended）、近期失败数（按作业名合并）、正在导入/发布的解决方案、最近安装的解决方案、**插件跟踪级别**（组织 `plugintracelogsetting`：关闭 / 仅异常 / 全部）。

失败判定用的是 `statecode 3`（Completed）**且** `statuscode 31`（Failed）：同一个 Completed 下还有 30 Succeeded、32 Canceled，只看 `statecode` 会把成功的作业算成失败，也会把成功的作业列进失败清单。

同一份「正在导入/发布」判定也被写入前的预检查复用。

读不到作业数据时不报 0：如果环境没勾「读取业务数据」，排队 / 挂起 / 失败三列显示 `—`，并在表下写明原因。以前这种情况会被吞成「0 个失败」，在排查时给出假的安全结论。

---

## d365_reports

本机产物与占用。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `action` | `list` \| `view` \| `cleanup` \| `compact` | `list` | |
| `file` | string | — | `view` 的文件：`.d365` 下的相对路径（`query/xxx.json`）或文件名 |
| `offset` | integer | 0 | `view` 从第几行开始（0 基） |
| `match` | string | — | `view` 只显示包含该字符串的行（不区分大小写），在大 JSON 里找一条 GUID 用这个 |
| `wrap` | integer | 400 | `view` 每行超过多少字符折行，0 表示不折行 |
| `pretty` | boolean | `.json` 为 true | `view` 是否把 JSON 缩进展开 |
| `target` | `snapshots` \| `reports` \| `diffs` \| `query` \| `changes` \| `all` | `all` | `cleanup` 的范围 |
| `dryRun` | boolean | **true** | 只预演；确认后传 `false` 才删 |
| `limit` | integer | 15 / 60 | `list` 每类列多少条；`view` 最多显示多少行（上限 2000） |

```json
{ "action": "cleanup", "target": "query" }
{ "action": "cleanup", "target": "query", "dryRun": false }
{ "action": "compact" }
{ "action": "view", "file": "query/2026-11-09T04-03-33-467Z-data-count.json" }
{ "action": "view", "file": "query/layers-uat.json", "match": "contoso_taxcategoryos", "offset": 40 }
```

`view` 只读 `.d365` 目录内的文件：绝对路径越界会被拒绝，而不是悄悄去读别的文件。大 JSON 默认缩进展开，配 `match` 找一条 GUID 比翻行号快。

清理只碰 `.d365/` 下的已知子目录，删前逐个校验路径前缀；`waivers.json`、`pending-writes/`、配置文件永不被删。

`reports` 按**一份报告**计数而不是按文件：每次分析写的是 `.json` + `.md` 一对，按文件算会让「保留 20 份」实际只留 10 份。

---

## d365_invoke

调一条 Dataverse 消息（action 或 function），返回 HTTP 状态与响应体——用来复现一次失败，或看某条消息到底返回什么。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `message` | string | — | 必填，消息名，例如 `WinOpportunity`、`contoso_DoSomething` |
| `method` | `POST` \| `GET` | `POST` | `POST`=action（可带请求体）；`GET`=function（参数按 OData 别名拼进 URL，不能绑定记录） |
| `entity` | string | — | 绑定 action 时必填：记录的实体集名（如 `accounts`） |
| `id` | string | — | 绑定 action 时必填：记录主键 GUID |
| `parameters` | object | — | `POST` 为请求体（action 的输入参数）；`GET` 为 function 的命名参数（值会按 OData 字面量格式化） |
| `environment` | string | 默认环境 | |
| `rationale` | string | — | 为什么要调这条消息，会写进产物与执行记录 |

```json
{ "message": "RetrieveTotalRecordCount", "method": "GET", "parameters": { "EntityNames": ["account"] } }
{ "message": "WinOpportunity", "entity": "opportunities", "id": "<guid>", "parameters": { "Status": 3 } }
```

**权限按方法分**：`GET` function 是读，走「读取业务数据」（`data.read`）；`POST` action 走「调用消息」（`message.invoke`，默认关闭）。POST 每次都在对话里弹确认卡，写明环境、路径、请求体；**调用失败不抛异常**，而是把 HTTP 状态、错误码和响应体原样返回——那正是复现问题时最需要的部分。

---

## d365_trace

读插件跟踪日志：谁跑了、跑了多久、为什么抛。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `action` | `list` \| `get` \| `summary` | `list` | |
| `traceId` | string | — | `get` 必填：`plugintracelogid`（通常来自 `list` 输出） |
| `hours` | number | 24 | 回看小时数 |
| `entity` | string | — | 只看某张表上的跟踪（`primaryentity`，如 `account`） |
| `typename` | string | — | 只看某个插件类型的跟踪；支持 contains，例如 `ContactSearch` |
| `message` | string | — | 只看某个消息的跟踪（`messagename`，如 `Create`） |
| `exceptionOnly` | boolean | **true** | 默认只看抛了异常的跟踪；传 `false` 连成功执行一起看 |
| `includeConfig` | boolean | false | `get`：是否返回 `configuration` / `secureconfiguration` / `profile`（默认 false，这些字段可能含明文密钥） |
| `top` | integer | 20 | `list` 返回行数（最多 200）；`summary` 分析的样本上限（默认 300，最多 500） |
| `environment` / `environments` / `allEnvironments` | | 环境选择 |

```json
{ "action": "summary", "environment": "sit", "hours": 168 }
{ "action": "list", "entity": "contact", "message": "Create", "hours": 48 }
{ "action": "get", "traceId": "44444444-4444-4444-4444-444444444444" }
```

三件事值得知道：

1. **成功执行的 trace 存空串，不是 null**。只写 `exceptiondetails ne null` 会把成功执行也当失败列出来，所以「只看失败」实际是 `ne null` 且 `ne ''`。
2. `summary` 按「插件类型 + 消息 + 表 + 异常首行」归并签名，300 条失败通常只有几个签名；签名一样就是同一个 bug 在反复发生。
3. 插件会把自己的凭据写进 messageblock（`secureConfig` 里的 `ClientSecret`），`list` / `get` / `summary` 三个动作在输出和产物里都会屏蔽成 `***` 并告诉你屏蔽了几处。**跟踪日志按业务数据处理**，需要「读取业务数据」（`data.read`）。

---

## d365_flows

查 Power Automate 云流。云流在 Dataverse 里就是 `workflow` 表 `category = 5` 的行，所以它和经典工作流同表、同权限、走同一套认证——**不需要 Power Automate 的 API 权限**。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `action` | `list` \| `show` \| `refs` | `list` | `list` 目录；`show` 一条流程的骨架；`refs` 哪些流程碰某张表 |
| `name` | string | — | `show`：流程名称（精确匹配，先 `list` 拿到） |
| `flowId` | string | — | `show`：`workflowid`（GUID），名称有重名或含特殊字符时用它 |
| `entity` | string | — | `refs` 必填：表逻辑名（如 `account`、`contoso_determinationlogictable`） |
| `filter` | string | — | `list`：附加 OData `$filter`，例如 `"statecode eq 1"` 只看已开启的 |
| `top` | integer | 50 | `list` 返回行数（最多 500） |
| `scanLimit` | integer | 1000 | `refs` 最多扫描多少条流程（最多 2000）；流程多时会逐页读 `clientdata` |
| `environment` | string | 默认环境 | |

```json
{ "action": "list", "environment": "dev", "filter": "statecode eq 1", "top": 20 }
{ "action": "show", "environment": "dev", "name": "Contoso Opportunity Research Flow" }
{ "action": "refs", "environment": "dev", "entity": "account" }
```

`show` 输出：状态、托管、触发器（含「当记录创建或更新，范围：组织，过滤列：…」这类细节）、动作数、涉及的表、连接器、连接引用，再给一张步骤表（只列前 40 个动作，其余见产物）。步骤路径用 ` > ` 表达嵌套，`（否则）`、`（caseName）` 标出分支。

四件事值得知道：

1. **`primaryentity` 全是 `none`**。云流不绑定单表，所以 `d365_metadata resource=workflows` 里看不出它碰哪张表；表名藏在 `clientdata` 的每个动作参数里（`entityName`），`refs` 就是把它们全解析出来反查。这一步没有服务端过滤可用，只能逐条读定义。
2. **运行历史不在 Dataverse**。失败在第几次、卡在哪个动作、耗时多少，这些只在 Power Automate 服务侧（`api.flow.microsoft.com`，另一套 audience 与 `Flow.Read.All`）。这个工具只到「定义」层：谁定义了、怎么触发、碰哪些表、用哪些连接。
3. **没纳入解决方案的云流也在**。它们落在默认解决方案里（`ismanaged = false`），`list` 能查到、`refs` 能扫到；要不要进解决方案是 ALM 的事，不是可见性问题。
4. `refs` 的输出会写「扫描 N/M 条」——扫描是上限内全量，`scanLimit` 调小会明确告诉你只扫了一部分，不会把截断说成「没有」。

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
