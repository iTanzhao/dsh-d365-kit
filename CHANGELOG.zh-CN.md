# 版本记录

**[English](CHANGELOG.md)** | 简体中文

版本语义：修 bug 升 patch，加工具/加能力升 minor，改配置结构或改名升 major。

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
