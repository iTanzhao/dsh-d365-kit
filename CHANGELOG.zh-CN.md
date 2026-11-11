# 版本记录

**[English](CHANGELOG.md)** | 简体中文

版本语义：修 bug 升 patch，加工具/加能力升 minor，改配置结构或改名升 major。

## 0.34.1

`d365_flows show` 的触发器多一行「条件」。这也是第一个发到 npm 注册表的版本（`install_bundle target="dsh-d365-kit@0.34.1"`），并顺手修掉安装页上过时的工具数（`15` / `16 个` → 19）。

- 之前只解析 `subscriptionRequest/filteringattributes`（监控哪些列），没解析 `subscriptionRequest/filterexpression`（真正的判断条件），于是「当记录创建，条件：`statuscode eq 1 and msdyn_activitytype eq 419550000`」这种最关键的过滤被漏掉；
- 实测 UAT 401 条云流里，带 `filterexpression` 的有二十多条，例如 `Contoso Evaluation Flow` 的四个 `and` 条件、`Contoso Insights Flow` 的 `msdyn_processedstage eq null and msdyn_opportunitypayload ne null`。

## 0.34.0

新工具 `d365_flows`：查 Power Automate 云流。

云流在 Dataverse 里就是 `workflow` 表 `category = 5` 的行，所以它和经典工作流同表、同权限、走同一套认证——不新增任何权限闸，也不需要 Power Automate 的 API 权限。

- **`list`**：目录（名称、状态、owner、托管、修改时间），支持 `filter`；owner 名从 `systemusers`/`teams` 批量解析（`ownerid` 是多态查找，`$expand` 会被服务端拒绝）；
- **`show`**：一条流程的骨架——触发器（含「当记录创建或更新，范围：组织，过滤列：…」这类细节）、动作数、涉及的表、连接器、连接引用，以及前 40 个动作的嵌套路径（`（否则）`、`（caseName）` 标出分支）；
- **`refs`**：哪些云流会碰某张表。触发器或任意动作命中就列出行，`account` 在 DEV 274 条云流里命中 6 条、`opportunity` 命中 11 条。输出写明「扫描 N/M 条」，扫描被 `scanLimit` 截断时不会说成「没有」；
- **踩到的坑**：`refs` 最初显式传 `$top: 50`，Dataverse 把显式 `$top` 当成**总量**，正好返回 50 行且不给 `@odata.nextLink`，于是「仅扫 50 条」看起来像「扫完了、没有碰这张表」。现在不传 `$top`，交给分页探测；
- **`primaryentity` 为什么是 `none`**：云流不绑定单表，表名藏在 `clientdata` 每个动作的参数里（`entityName`），`refs` 就是把它们解析出来反查——这也是 `d365_metadata resource=workflows` 答不了「谁碰了这张表」的原因；
- **运行历史查不到**：失败在第几次、卡在哪个动作、耗时多少只在 Power Automate 服务侧（另一套 audience 与 `Flow.Read.All`）。这个工具只到「定义」层，文档里写清楚了；
- 没纳入解决方案的云流同样能看到（落在默认解决方案里，`ismanaged = false`）。

## 0.33.2

文档：工具参考与排查 skill 的开头各加一张「按问题查」的路由表。

- **`docs/zh/tools.md` / `docs/en/tools.md` 开头新增路由表**——16 个问题、对应工具，以及「容易误用成什么」（改一批记录该用 `d365_data_sync plan-update` 而不是 `d365_data_write`；「这个字段为什么不在表单上」该用 `d365_refs` + `d365_layers` 而不是只看 `attributes`；「两个环境差在哪」该用 `d365_sync` + `d365_diff` 而不是两边各查一遍对眼）；
- **`skills/d365-troubleshooting/SKILL.md` 也带上同一张表**，排查时随 skill 一起加载，不用先查文档；
- 「只读与写入」的约定补上 `d365_invoke`（POST）也属于会改环境、需要确认的调用。

## 0.33.1

自检剩下的 medium 项——都是同一个小毛病的小一号版本：答案看着合理，但数据撑不住。

- **`d365_layers solution=` 原来在分页之后过滤**：层数超过 `top`（默认 500）时，明明存在的层会被报成「该解决方案没有层」。现在过滤进 `$filter`，服务端先筛再截（UAT 实测：`solution: "Active"` 正好返回 `contoso_taxcategoryos` 那一层 Active）；
- **`d365_diff` 比较 `solution_components` 时用了每个组织各自分配的 GUID**，DEV↔Build 一次报出 22.7 万新增 + 21.8 万删除。现在按 `componenttype` 计数比较，报告里写明；同一次 DEV↔Build 变成「新增 0 / 删除 0 / 修改 362」（计数层面）；
- **`d365_migrate` 把被导入的解决方案本身和 `Active` 伪解决方案**也算进「将被遮蔽的解决方案」。这两个都不会失去什么：被导入的那个是替换这些层，`Active` 根本不是解决方案；
- **`d365_code_check` 的「不确定匹配」分支不可达**：相近名返回 `assembly: null`，于是被报成「没有这个程序集」，「请确认映射」的提问从不触发。现在只有一个相近名时会带人工确认，多个相近名仍作为未解决列出；
- **HTTP 超时原来只管到响应头**：`timedFetch` 在 `fetch` 一解决就清了定时器，服务端发完响应头再卡住正文时，`response.text()` 不受超时约束。现在定时器保持到正文读完，卡住的正文报网络错误；
- **`d365_reports` 按报告文件计数**：每次分析写的是 `.json` + `.md` 一对，`reportKeep: 20` 实际只留 10 份，而且写完立即清理可能删掉同一对里的另一半。现在一对算一份，一起删；
- **选项集计划忽略 `language`**：`plan-add-options` / `plan-relabel` 固定写 `languageCode: 1033`，`UpdateOptionValue` 还带 `MergeLabels: false`，把其它语言的标签一起换成了英文。现在计划遵守 `language`（实测 `language: 2052` 落成 `languageCode: 2052`），改标签只合并到指定语言。

## 0.33.0

全仓自检一遍（`lib/` 47 个模块 + `index.js` + 1.7K 行的 `client.js`），修掉十几个「不报错、但给出错误结论」的 bug。

- **权限页「全部取消」原本无效**：一个环境全不勾选时整条被丢弃，而「没有条目」等于用默认授权（元数据读又回来了）。现在空数组照样写入，保存后按服务端重读，而不是相信自己的草稿；
- **保存设置页可能抹掉环境的凭据来源**：页面没有 `tenantIdEnv` / `clientIdEnv` / `note` 的输入框，服务端又把「请求里没有的字段」当删除。现在客户端把它们原样带回，服务端只改请求里出现的字段；
- **保存环境的接口没有同源校验**：其它写路由都要求 `x-d365-meta-write` 头，唯独写 URL 与 client secret 的这个没有。页面补上请求头，路由补上守卫；
- **执行确认卡写的与实际执行相反**：卡上只有四个可覆盖项，`保持 GUID` / `保留创建时间` / `抑制重复检测` 因此全显示「否」，实际执行却按计划里的「是」来。现在从计划的完整选项集出发；
- **批量更新第一次执行会「写成功又判失败」**：runs 目录只有迁移路径建过，批量更新写完所有 PATCH 后写执行记录 ENOENT，计划被标 failed。顺带：引用回填失败计入失败行而不是藏在结果里；`onMissingLookup: "fail"` 终于会拒绝——「这条记录有未解析引用」原本是按同一个策略算的，所以守卫永远看不到；
- **批量更新接受任意大小写的列名**，但只归一化了字段表、没归一化值，预览打印 `undefined`、PATCH 发的是计划里没显示的键。现在值按逻辑名归一；
- **`update-attribute` / `delete-attribute` / `update-entity` 忽略默认解决方案**：三个 planner 都校验了解决方案却不把 `solutionUniqueName` 放进 operation，设了默认解决方案时改动落到默认层。视图列调整另外补了列名校验，并改用函数式替换，layoutxml 里的 `$&` 不再被展开；
- **`d365_data` 把实体名原样拼进 `$filter`**（`odataString` 导入了却没用）：名字里有单引号会被 400 吞成「实体不存在」，构造的名字还能扩大过滤范围。现在只接受逻辑名形态；
- **`d365_health` 没权限时报「0 个失败」**：三个作业查询都是 `catch(() => null)` 再 `?? 0`，缺 `data.read` / 403 时在排查工具上给出假的安全结论。现在三列显示 `—` 并写明原因；
- **`d365_trace` 只在 `get` 里屏蔽凭据**：`list` 与 `summary` 把原始 `exceptiondetails` 写进产物和对话。现在三个动作都屏蔽；
- **`d365_sync` 提供按实体取的资源却没有实体参数**（`attributes`、`keys`、`*_relationships`），会拼出 `LogicalName='undefined'`；现在跳过并在「问题」里说明。`d365_contract` 补上「已过期豁免」计数，`handler-missing` 改为按环境去重（以前同一个缺函数只在第一个环境报）；
- 设置/配置 JSON 的临时文件名加了随机后缀：同一进程两次并发保存共用 `${path}.tmp-${pid}`，可能把彼此写了一半的内容改名落盘。

## 0.32.1

上一版把 skill 写好了，却让人手工复制到 `~/.dsh/skills/`——装插件不会带过去，等于没装。这一版改成插件自己注册。

- 新增 `lib/skill.js`：读包里的 `skills/d365-troubleshooting/SKILL.md`，解析 front matter，交给 Host 的 `skills` 服务注册（`source: "bundled"`、`modelInvocable`/`userInvocable` 都为真）。注册走 `ctx.inject(["skills"], …)` 晚绑定：宿主没有这个服务时静默跳过，老版本 Host 仍然只有工具；
- 因此 `install_bundle` 之后 skill 就在技能目录里，agent 按描述自动路由，用户不需要按名字调用；
- 卸载/禁用插件时注册随之撤销（技能目录里同步消失），不存在「删了插件、skill 还留着」的残留；
- INSTALL 中英两段从「手动复制」改成「装完即有；要改就改包里那份」；`package.json` 的 `files` 已包含 `skills/**`，发布包带得走。

## 0.32.0

这一版加的是 skill，不是工具：能力早就有，但「先看什么、后看什么」没写下来。

- 新增 `skills/d365-troubleshooting/SKILL.md`——插件失败的排查 skill：先确认环境、`data.read`、跟踪级别；先看异步作业再怀疑插件；用 `d365_trace summary` 把几百条失败归成签名；`get` 取一条完整调用；核对步骤到底注册在哪（消息 / 阶段 / 模式 / 过滤属性）；最后用 `d365_invoke` 复现；
- 顺带把错误码表固化了（`0x80048d19` 请求体形状、`0x80040216` 记录不存在、`0x80040333` 重复检测、`0x80044150` 并发冲突、`0x80048423` 受管组件、`0x8004a0f6` 状态转换、`0x80060888` 不支持的属性），以及三个真花过时间的坑：成功执行的 trace 存空串、`$count` 在 5000 截断、元数据读与业务数据读是两道闸；
- 安装方式：复制到 `~/.dsh/skills/d365-troubleshooting/`（见 INSTALL）。就是纯 Markdown，按各自环境改。

## 0.31.0

批量改数：在一个环境里按显式 id 清单改多条记录的字段，形态与迁移一样——先只读预演，再人工确认。

- `d365_data_sync` 新增 `action=plan-update`：一个环境、一份显式 `ids`（去重，上限 1000 条）加一份 `values`（字段逻辑名 → 新值）。预演会读出现有值做 **before → after** 预览（前几条），列出不存在的 id，并让你确认「记录范围、更新字段、Bypass」三项；
- **故意不接受 `filter` / `fetchXml`**：按查询条件批量改没有撤销键。先用 `d365_data action=query` 查出 id，再传进来；
- 只支持标量字段：`values` 里出现 lookup 会以 `lookup-unsupported` 拒绝，因为 lookup 必须按导航属性名绑定（单条改走 `d365_data_write`）；
- 执行沿用迁移那套保障：`plan-update` 要 `data.read`，`execute` 要 `data.write` 且人在确认卡片上批准；写请求按有界并发跑、默认带 `MSCRM.BypassCustomPluginExecution`，逐 id 的执行记录落在 `.d365/data-sync/runs`。只改不删。

## 0.30.0

这一版补的是「看现场」：能查一条记录、能调一条消息、能读插件跟踪日志。

- 新工具 `d365_trace`（读插件跟踪日志）：`list` 列最近的失败、`get` 看某一条的异常全文与 messageblock、`summary` 按「插件类型 + 消息 + 表 + 异常首行」归并签名——300 条失败通常只有几个签名，签名一样就是同一个 bug 在反复发生。默认只看抛异常的记录；顺带修正一个真问题：**成功执行的 trace 存空串而不是 null**，只写 `exceptiondetails ne null` 会把成功执行也列成失败（实测 sit 168 小时从 300 条 / 25 个签名收敛到 104 条 / 7 个签名）；
- `d365_trace` 会屏蔽插件写进 messageblock 的凭据（`secureConfig` 里的 `ClientSecret`、`Authorization: Bearer …`），输出与产物里都是 `***` 并告知屏蔽了几处。跟踪日志按业务数据处理，需要「读取业务数据」；
- 新工具 `d365_invoke`（调一条 action / function）：返回 HTTP 状态与响应体，**失败不抛异常**，把状态码、Dataverse 错误码和响应体原样给出来——复现问题时这一步最有用。权限按方法分：`GET` function 走「读取业务数据」，`POST` action 走「调用消息」（`message.invoke`，默认关闭，每次都在对话里确认）；
- `d365_data` 新增 `action=query`：自选列、排序、`$expand`、按主键取一条（支持带引号的备用键），标题区分「共 N 行 / 已列 N / 共 M 条 / 可能还有更多」。以前只有 count/group/sample，想看具体某几条得自己拼 OData 再绕过工具。

## 0.29.0

这一版修的是「看结构」时最容易误导人的几个地方：错误码被丢掉、清单被静默截断、派生列读不到、产物读不回来。

- 修复：`D365Error` 现在保留 Dataverse 错误码与响应体。以前 `0x80048d19` 只活在一行中文消息里，模型复制不出来也搜不到；现在错误对象带 `errorCode`、`body`，并在消息里附上该码的成因与下一步（`0x80048d19` 载荷形状、`0x80060888` 属性或查询参数不被支持、`0x80040333` 重复检测、`0x80044150` 并发冲突等）；
- `d365_metadata` 新增 `step_images` 资源（插件步骤的注册镜像：镜像类型、别名、参与镜像的字段），`plugin_steps` 默认 `$expand` 插件类型与消息名——步骤的 `name` 经常是空的，以前摘要里认不出是哪一步；
- 清单型资源（`plugin_steps`、`plugin_types`、`step_images`、`attributes`）默认上限从 200 提到 1000。成熟组织的 `sdkmessageprocessingsteps` 实测 5000 条以上，200 行 + 按名称排序会让要找的步骤「看起来不存在」；
- 结果被截断时摘要改成「已列 N 条 / 共 M 条（M 取自服务端 `$count`，其上限 5000 显示为 ≥5000）」，不再只有一句「还有更多」；
- `d365_metadata` 支持按字段 keyed 读取并 cast 到派生类型（`attribute` + `cast`）：`DefaultValue`、`OptionSet`、`Targets` 这些列不在 `AttributeMetadata` 基类型上，以前 select 它们只能拿到 400；
- 显式传 `select` 时摘要表格跟着显示这些列（以前固定按资源默认列渲染，"我要的 DefaultValue" 会被四列默认字段挡掉）；
- `d365_health` 增加「插件跟踪」列（组织 `plugintracelogsetting`：关闭 / 仅异常 / 全部）。查不到跟踪日志最常见的原因就是它是关的，而这一列以前完全不可见；
- `d365_reports` 新增 `action=view`：按行窗口读回一个产物，支持 `match` 过滤、`offset`/`limit` 翻页、`wrap` 折行，`.json` 默认缩进展开；只允许读 `.d365` 目录内的文件，越界的绝对路径会被拒绝。以前只有「文件名 + 大小」，500 KB 的结果等于没保存。

## 0.28.1

迁移写入改用真实的导航属性名，设置页的语言也跟着 DSH 切了。

- 修复：`d365_data_sync` 原来拿字段逻辑名拼 `@odata.bind`，而 Web API 认的是关系的**导航属性名**。自定义关系里两者常常不同（`contoso_approverid` 要绑 `contoso_ApproverId`、`contoso_geographicunitid` 要绑 `contoso_GeographicUnitId`），这类字段原来 100% 报 `0x80048d19 … An undeclared property`，而预演看不出来。现在每个实体先从 `RelationshipDefinitions` 读一张「逻辑名 → 导航名」映射，写请求按导航名绑定；预演会把两者不同的字段单独列出来，读不到映射时退回逻辑名并在「需要注意」里说明；
- 修复：旧版本存下的待执行计划没有这张映射，`execute` 现在直接以 `stale-plan` 拒绝，提示重新 `plan`，不再把旧错误重复一遍；
- 写请求的 `content-type` 补上 `charset=utf-8`，非 ASCII 值不再依赖服务端猜编码；
- 修复：设置页原来在 `apply` 里只读一次 `ctx.get('locale')`，locale 服务晚到就永远拿不到，整页恒为英文。改成 `ctx.inject(['locale'])` 等它就绪，并用模块级订阅把语言变化推给已挂载的页面；词典也改成一次 `register('d365-meta', DICT)`。

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
