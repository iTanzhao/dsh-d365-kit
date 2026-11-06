# 版本记录

**[English](CHANGELOG.md)** | 简体中文

版本语义：修 bug 升 patch，加工具/加能力升 minor，改配置结构或改名升 major。

## 0.28.0

删未受管层不再只限表和字段，`d365_layers` 认识的组件类型全部支持。

- `d365_write plan-remove-layer` 接受全部 11 种 `componentType`（`Entity`、`Attribute`、`OptionSet`、`SavedQuery`、`Workflow`、`SystemForm`、`WebResource`、`PluginType`、`PluginAssembly`、`SdkMessageProcessingStep`、`CustomAPI`）；发给 `RemoveActiveCustomizations` 的数值 `ComponentType` 取自真实服务上的 `solutioncomponent.componenttype` 选项集，不是猜的（`CustomAPI` 用它所在表自身的 object type code，10519）；
- 计划里先完整列出层栈，再说明删完由哪一层接管，删之前不用打开 JSON 也能核；
- 删除后的发布范围跟着组件走：表或字段发布该表，表单或视图发布其所属表，选项集发布该选项集，其余走全量发布——归属查不到时不猜，退回全量发布而不是发错范围；
- 修复：不归属任何表的表单，Dataverse 的 `objecttypecode` 会返回字面量 `none`，原先会被当成表名传进发布；现在按「不缩小发布范围」处理。

## 0.27.0

全局选项集能查层了，层输出说清了 `Active` 是什么，令牌也从「每个请求取一次」改成「并发只取一次」。

- `d365_layers` 支持 `componentType: OptionSet`：先用 `GlobalOptionSetDefinitions(Name='…')` 取 `MetadataId`，再按 `msdyn_solutioncomponentname = 'OptionSet'` 查层表。本地选项集跟着字段走，仍用 `componentType: Attribute` 加 `entity` 查；
- 层输出把未受管层标成 `Active（未受管）`，每个环境末尾明确一句：最上层是未受管层，还是这个环境根本没有未受管层。Active 层的更新时间显示「不记录」（它的 `msdyn_overwritetime` 恒为 `1900-01-01`，原来会渲染成一个假日期）；
- `d365_metadata` 的 `option_sets` 新增 `name` 参数：一次 keyed 请求取一个，不用再拉全部 987 个；找不到返回 404，报「该环境没有名为 X 的全局选项集定义」；
- 给 `option_sets` 传 `filter` 会被当场拒绝（`filter-unsupported`），不再把原始的 `$filter is not supported` 抛给用户——该端点返回 HTTP 405；
- 取令牌改成并发合流：同一环境的并发请求共用一个令牌请求（实测 8 个并发原本发 8 次 OAuth，现在 1 次），提前刷新窗口从 1 分钟放宽到 2 分钟；
- `d365_layers` 的 description 现在列出全部 11 种支持的组件类型，传错 `componentType` 不必再靠一次失败去发现。

## 0.26.0

解决方案层现在可写了，但只开一种：移除未受管的自定义层。

- `d365_write` 新增 action `plan-remove-layer` 与能力 `layer.remove`（「移除自定义层」，高危、默认关闭）：只有最上面那层显示为 `Active`（未命名的未受管层）时才删，删完由解决方案最后带来的那层重新生效；
- 计划里写出整条层栈、被删的层、以及接手的是哪一层（没有下层就是「系统定义」）；执行仍走同一张确认卡片和同一次发布，发布范围收窄到受影响的表；
- 背后只有 `RemoveActiveCustomizations` 一个消息。最上层属于某个解决方案时直接拒绝（`not-active-layer`）：那种定义归那个解决方案管，要么在解决方案里移除组件，要么发一个新 patch 覆盖它；
- `DeleteAndPromote` 与 `RemoveSolutionComponent` 明确不做；
- 层的解析函数（`COMPONENT_TYPES`、`resolveComponentId`、`buildComponentFilter`）从 `lib/tool-layers.js` 导出，读和写共用同一套解析；
- `RemoveActiveCustomizations` 加入元数据写白名单，所以这个操作要的是 `layer.remove`，而不是 `data.write`。

## 0.25.0

元数据读取变成一项独立权限，权限页也从一个宽表改成按环境分块。

- 新增能力 `metadata.read`（「读取元数据」），默认开启、排在权限页最前：关掉它连表、字段、表单、视图、层都读不到；至此每一次访问都会先查权限，请求没通过闸就到不了环境；
- `lib/client.js` 一处判定：元数据实体集要 `metadata.read`（`metadata-read-forbidden`），其余 `GET` 要 `data.read`（`data-read-forbidden`），非 `GET` 的写要 `data.write`（`data-write-forbidden`）——都在取令牌之前；
- 权限页每个环境单独一块、用分隔线隔开，块头显示该环境「已授权 x/y」；「元数据默认可读」的说明只在标题下出现一次；
- `write.environments` 的条目改为三态：没有条目 = 未配置（元数据默认可读）、空数组 = 全部关掉、列表 = 只开列出的这些。之前空数组在读取时会被丢掉，等于悄悄把默认值又打开了；
- `write.capabilityVersion`（2）用来区分「旧文件里的条目还没见过 metadata.read」：这些条目会被自动补上它，升级后行为不变。

## 0.24.1

第一次真写 550 条全部失败：每个请求都返回 `0x80048d19 … A 'PrimitiveValue' node with non-null value was found when trying to read the value of the property 'contoso_bg'`。一条也没写进去，修好后用同一个计划重跑。

- lookup 改为按 `@odata.bind` 导航属性发送 —— `"contoso_bg@odata.bind": "/contoso_geographicunits(<guid>)"` —— 而不是把裸 GUID 写进属性列；Dataverse 对任何 lookup 都拒绝后者；
- `ownerid` 同样用 `@odata.bind`，按源所有者实际类型指向 `/systemusers(...)` 或 `/teams(...)`，且只在所有者需要重映射时才写；
- 延后解析的 lookup（父记录创建后才拿到目标 GUID）不再塞进新建请求体，改为创建后用 `PATCH` 补；原代码只处理了普通列；
- 离线写路径测试改为断言请求体的真实形状，不再只判断「有某个键」——这正是裸 GUID 之前能混过去的原因。

## 0.24.0

`d365_data_sync` 按真实测试的用法改预演流程：第一次真迁移（SIT → DEV）暴露了「不问条件就出全量计划」的问题。

- 预演报告必须列清三件事并请执行者确认：**迁移条件**（默认整表；数据量大时建议用 `since` / `filter` / `ids` / `fetchXml` 缩小）、**迁移字段**（默认全部；清单里含主键就等于保持 GUID 一致）、**是否 Bypass 自定义插件**（默认跳过）；
- 不给条件不再报错：默认按整表预演，并在「需要注意」里说明读到多少条、是否已到 `maxRecords` 上限、其余未纳入本次计划；
- 预演报告新增「权限（execute 需要）」段：源读取 / 目标读取 / 目标写入各自是否已开启；缺 `data.write` 时当场提示去设置页「权限」勾「新增/修改业务数据」，而不是等 `execute` 才被拦下；
- Bypass 默认改为开（跳过目标环境的同步插件，避免触发下游通知/集成）；`execute` 时也可以显式传 `bypassPlugins=false` 关掉。

## 0.23.0

新增 `d365_data_sync`：业务记录跨环境迁移。

- 两段式：`plan` 只读预演（落 `.d365/data-sync/plans`），`execute` 在确认卡片上批准后才写（记录落 `.d365/data-sync/runs`）。计划里写明数据量、字段清单、每个 lookup 的解析结果、owner 映射、冲突与「是否 Bypass 自定义插件」；
- 默认镜像：保持源 GUID（带 `overriddencreatedon` 保留创建时间、`MSCRM.SuppressDuplicateDetection`）；`keepGuid=false` 时由目标分配主键，批内引用按依赖顺序重映射并在创建后二次 `PATCH` 补齐（环也能走通）；
- lookup 先按 GUID 在目标找同一条，再按主名精确匹配；命不中记「缺失」，多处同名记「歧义」。多态 lookup 先在源环境确定它指向哪张表——`Targets` 在基础 `AttributeMetadata` 上不可选（0x80060888），改从 `LookupAttributeMetadata` 读；
- 范围必须明确（`since` / `filter` / `ids` / `fetchXml`，或 `mode=all` 配 `maxRecords`），范围不明直接报错要求补充，不猜「今天新增的」；
- 目标已存在同 GUID 默认只报告不写，`conflict="overwrite"` 才逐条 `PATCH`；缺失引用默认跳过这些记录，`null` 清空、`fail` 整体拒绝；
- 权限沿用两道闸：`plan` 要源和目标 `data.read`，`execute` 还要目标 `data.write`；只新增/修改，不删记录。

## 0.22.2

真实 UAT 环境上发现的问题修复。

- `d365_health` 不再把 Completed 的异步作业算成失败、把 Ready 算成挂起：`asyncoperation` 的 `statecode` 是 0 Ready / 1 Suspended / 3 Completed，失败要再看 `statuscode 31`（Completed 下还有 30 Succeeded、32 Canceled）。在 UAT 上「近期失败」从 59,293 降到 124——正是 `statecode eq 3 and statuscode eq 31` 的条数——失败清单也不再混入成功的作业（原先列出的某作业 577/577 行都是 statuscode 30）。Ready 的作业单独有「排队中」一列，失败行带上真实的 `operationtype`；
- `d365_metadata` 的 `workflows`（以及 `business_rules`）默认只返回定义行（`type eq 1`）：Dataverse 给每个流程另存一条同名、`workflowid` 不同的激活行（`type 2`），于是每个流程出现两次、计数翻倍。显式传 `filter` 时默认过滤让位而不是 AND（所以 `type eq 2` 可用），`type` 也进入展示列；
- `d365_layers` 在多环境查询时，某个环境没有该组件不再让整次调用失败：键值元数据查询的 404 视为「该环境没有」，只在该环境报告，其它环境照常返回层并参与对比；全部环境都没有才报错；
- 产物路径改为绝对路径（`writeArtifact`），返回里打印的路径可以直接从会话工作区打开，不再是相对插件 cwd 的 `../../../Documents/...`。

## 0.22.1

按 npm 包的要求补齐。

- `package.json` 增加 `repository`、`homepage`、`bugs`、`keywords`、`author` 与 `publishConfig.access: public`，npm 页面上不会是一片空白；
- 文档把 npm 装法提到第一位（`install_bundle target="dsh-d365-kit@<版本>"`），Git 与本地目录作备选；`PUBLISH.md` 补了公网 npm 与内网 registry 两种 `npm publish` 写法。

## 0.22.0

配置可移植。

- Handler 检查不再内置项目前缀：`handlerPrefixes` 默认为空，改从源环境的未受管解决方案推断（占多数的发布者前缀，再加 `new_`）。合作方与示例解决方案被排除——它们压缩过的脚本会让每个 Handler 都像缺失；
- 漂移报告与工具输出会说明用了哪些前缀、来自配置还是自动推断；
- `d365.config.example.json` 增加 `handlerPrefixes`。

已在真实环境验证：用自动推断出的前缀，Handler 检查结果与原先写死的前缀完全一致（同样 14 条）。

## 0.21.0

发布整理版。

- 文档重组：README 作为入口，新增 `docs/`（安装、工具参考、场景、权限、检查规则、故障排查、结构）与 `examples/`；
- 新增 `CHANGELOG.md`、根目录 `.gitignore`；
- 每份文档都有中英两版：`README.md` / `README.zh-CN.md`、`INSTALL.md` / `INSTALL.zh-CN.md`、`CHANGELOG.md` / `CHANGELOG.zh-CN.md`、`docs/en/` / `docs/zh/`（文件名一致）、`examples/prompts.en.md` / `examples/prompts.zh-CN.md`，每篇顶部都有语言切换；
- `d365.config.example.json` 补齐权限、保留策略、GitLab 段；
- `package.json` 的 `files` 加入文档与示例；
- 采用 MIT 许可证（`LICENSE` 与 `package.json` 的 `"license": "MIT"`）。

代码与 0.20.0 一致，无行为变更。

## 0.20.0

改名为 `dsh-d365-kit`。

- 包名、bundle entry id、`index.js` 的 `name`、`client.js` 的模块 id 统一为 `dsh-d365-kit`；
  后两个是运行时自报名字，漏改会让加载器把同一模块执行两次，报 `duplicate factory registration` 并让整个设置页消失；
- 设置页标题改为「D365 工具箱 / D365 Toolkit」，描述覆盖读、写、检查三类能力；
- `locale/{zh,en}.json` 的 `tools` 补到 15 条；
- 新增 `INSTALL.md`；`cordis.patch.yml` 注释恢复 UTF-8。

## 0.19.1

审查后的四项修复。

- `/write/cancel` 检查计划状态：非 `pending` 一律 409，不再能删掉正在执行的计划；
- `/write/publish` 重新校验写权限与环境空闲，忙时返回 409 而不是原始 429；
- 删除文件的阻断只在确实还有表单引用时报；
- JS 引用分析拆成「字段 / 列 / 需人工判断」三组，字段缺失按字段聚合：所有表单都没有 = 阻断，只有部分没有 = 警告。

## 0.19.0

- `executePlan` 增加计划状态机 `pending → running → done/failed`，第一次写入前落 `running`；工具与设置页都拒绝非 `pending` 计划；
- 重试策略按方法区分：`GET`/`HEAD` 在网络错误与 5xx 上重试，`POST`/`PATCH`/`DELETE` 只在 429 时重试；
- 表单 Handler 检查收敛：只看项目脚本、先查自己的库、预算 400 个脚本，误报从 306 条降到 14 条；
- `d365_reports` 的总数改用磁盘统计，截断时明确标注；
- 健康检查不再渲染空的失败原因。

## 0.18.0

数据治理。

- 保留策略：快照 / 报告 / diff / 查询留证 / 变更记录各有份数与天数上限，写产物后自动清理；
- `d365_reports` 增加 `cleanup`（默认预演）与 `compact`（缩进 JSON 压成单行）；
- 设置页新增「数据」标签：占用、每类明细、预演与执行、压缩；
- 快照写入改为单行 JSON，实测四份快照省 68 MB；
- 修复设置页某路由未声明请求体模式导致 GET 返回裸 400 的问题。

## 0.17.0

- 契约豁免（`waivers.json`，必须有过期时间）与漂移趋势（`contract-history.json`）；
- 契约检查补充表单引用的 Web 资源、站点地图、表单 Handler；
- 新增 `d365_health`（挂起/失败作业、正在进行的导入发布）；
- 新增 `d365_reports`（产物索引）；
- 同一 `message|stage` 多步骤时提示 rank 冲突；JS 取值写法扩到 9 种；
- 快照过期提示、权限「复制到其他环境」。

## 0.16.0

契约矩阵与漂移引擎 `d365_contract`：程序集、插件类型、步骤（消息 + stage + mode）、选项值。

## 0.14.0 – 0.15.0

- `data.write` 与 `d365_data_write`：新建/修改业务记录，需授权且每次确认，审计不落值；
- `d365_code_check` 增加 C# 分支：程序集精确匹配、类型/步骤/镜像/过滤属性核对，共享工程降为警告。

## 0.11.0 – 0.13.0

- `d365_code_check`：GitLab MR → Web 资源 → 表单字段/Handler 核对，输出阻断/警告/人工确认；
- 设置页新增 GitLab 标签（地址、默认项目、只读令牌、连通性测试）；
- `d365_refs`：字段 / Web 资源 / 程序集的反向索引；
- `d365_data`：count / group by / sample，受 `data.read` 管控。

## 0.7.0 – 0.10.0

- 设置页改为六标签（环境、权限、计划、数据、GitLab、常规），语言跟随 DSH；
- 执行前检查：环境正在导入/发布时拒绝写入；
- 只发布受影响的组件（`PublishXml` 而非 `PublishAllXml`），后台执行并记录结果；
- 迁移评估 `d365_migrate`：层遮蔽、缺失、选项值丢失、版本与受管状态。

## 0.1.0 – 0.6.0

- 元数据查询（19 类资源）、多环境对齐；
- 解决方案层 `d365_layers`（虚拟实体，必须组件 id + 类型）；
- 快照 `d365_sync` 与对比 `d365_diff`（manifest 记录完整性、噪声过滤）；
- 环境配置与设置页；
- 写入能力：选项集增/改/删值、字段增/改/删、表显示名、系统视图列；计划 → 人工确认 → 执行 → 审计；
- 修掉一批真实环境差异：`organization` 列缺失、元数据端点不支持 `$top`/`$orderby`、换用户后令牌缓存未失效、层表必须带类型。
