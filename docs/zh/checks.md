# 检查规则

**[English](../en/checks.md)** | 简体中文

三类检查工具回答不同问题：

| 工具 | 问题 | 数据来源 |
| --- | --- | --- |
| `d365_migrate` | 把这个解决方案导进目标环境会发生什么 | 实时读，逐组件查层 |
| `d365_contract` | 上游的注册与引用，下游是否还在履行 | 实时读（漂移要看当下） |
| `d365_code_check` | 这次 MR 的代码改动在目标环境跑得起来吗 | GitLab MR + 实时读环境 |

共同约定：**高置信直接阻断，中置信降为警告，静态判不了的进人工确认**——宁可让人多看一眼，也不要用一条误报把工具变成噪声。

---

## 迁移评估（d365_migrate assess）

逐组件比对，产生这些发现：

| 规则 | 判据 | 级别 |
| --- | --- | --- |
| `component-missing` | 组件在目标环境不存在 | info |
| `solution-absent` | 目标没有这个解决方案（首次导入） | warning |
| `version-not-newer` | 目标版本不低于源版本（导入不会覆盖成新的） | warning |
| `managed-mismatch` | 源与目标的受管状态不一致 | warning |
| `source-unmanaged` | 源是未受管，导入后形成无法卸载清除的层 | warning |
| `option-values-lost` | 目标有、源没有的选项值——导入后会被删掉 | **critical** |
| `option-label-drift` | 同一值标签不同 | warning |
| `shadowed` | 目标该组件最上层是别的解决方案，导入后其定义失效 | 汇总列出 |

### 组件类型与层

层表能按名称查的类型只有六种：

| `msdyn_solutioncomponentname` | componenttype |
| --- | --- |
| `Entity` | 1 |
| `Attribute` | 2 |
| `OptionSet` | 9 |
| `EntityRelationship` | 10 |
| `Workflow` | 29 |
| `WebResource` | 61 |

其余类型（36 报表、50 图表/安全类、70 应用类…）在层表里查不到对应名称，只做**存在性检查**，报告里标「未评估」。

跨环境识别的键来自层记录的 `msdyn_componentjson`：Entity → `logicalname`，Attribute → `logicalname` + 父表，OptionSet → `name`，EntityRelationship → `schemaname`，Workflow → `name` + `category`，WebResource → `name`。

### 为什么慢

`msdyn_componentlayer` 是虚拟实体，只能按「组件 id + 组件类型」逐个查，无法按解决方案批量取；单组件约 2 秒。所以有 `maxComponents`（默认 150）与 `concurrency`（默认 4，上限 8），`full: true` 才评估全部。

### 读报告的顺序

1. 先看**严重**：有没有丢选项值；
2. 再看**遮蔽**：导入后谁的定义会失效，是不是自己家的受管 patch；
3. 最后看**缺失与版本**：目标缺组件通常意味着发布链路上少了一步；
4. 结论落地：能并入受管解决方案随升级走，就不要单独发一个未受管的小解决方案——层是按导入时间叠的，下一次谁的 patch 进来就会把它盖回去。

---

## 契约漂移（d365_contract）

把上游的插件注册与可视化组件引用当成**契约**，检查下游是否还满足。

| 规则 | 判据 | 级别 |
| --- | --- | --- |
| `assembly-missing` | 上游有、下游没有该程序集 | 阻断 |
| `assembly-version-older` | 下游版本低于上游 | 警告 |
| `plugin-type-missing` | 上游注册的类型，下游没有 | 阻断 |
| `plugin-step-missing` | 类型在，但缺「消息 + stage + mode」组合的步骤 | 阻断 |
| `form-library-missing` | 下游表单引用的 Web 资源不存在 | 阻断 |
| `sitemap-missing` | 上游的自定义站点地图在下游没有 | 警告 |
| `handler-missing` | 表单 Handler 指定的函数在项目脚本里找不到 | 警告 |
| `option-value-missing` | 下游缺上游的选项值（或多出上游没有的值） | 警告 |

细节：

- 默认只比**未受管**程序集；受管程序集来自微软或受管解决方案，本地改不了；
- 步骤按「类型 + 消息 + stage + mode」比对：async 与 sync 是两条不同的契约；
- 选项值比对需要显式传 `optionSets`（逐个读 `GlobalOptionSetDefinitions`），不传就不比；
- 下游比上游**多**的内容不报阻断，只在选项集多值时提示「确认是否已回灌」。

### Handler 检查

`handlers: true` 时下载表单引用的项目脚本，核对 `functionName` 是否存在。

- 只判定**项目脚本**。前缀默认从源环境的未受管解决方案推断——取占多数的那个发布者前缀，再加 `new_`——所以换一个组织、换一个前缀都不用改配置；要精确指定就在配置里写 `handlerPrefixes`。合作方与示例解决方案故意排除：它们的包是压缩过的，内部名字被混淆，全算进来每个 Handler 都会像缺失（某真实环境上：94 条而不是 14 条）；
- 先查 Handler 自己的库，找不到再扩大到该表单加载的其它项目库（表单级共享作用域是真实存在的：一个库提供函数，另一个库绑定）；
- 平台注入的 Handler（`absoluteurl_onchange`、`Main_Form_onload` 等）来自系统脚本，不参与判定；
- 逐个下载有上限（400 个脚本/环境），超出的部分按「读不到内容、无法确认」处理，不误报成阻断。

首版按「表单加载的全部脚本库」判定时产生 306 条警告，收敛到「项目库 + 自己的库优先」后是 14 条，全部是读完了确实没有。**这个数字本身就是设计目标：可行动的少量，而不是不可读的大量。**

### 豁免与趋势

```json
{ "action": "waive", "rule": "form-library-missing", "env": "sit",
  "object": "/_static/_common/scripts/CommandbarActions.js", "reason": "该环境不用 SLA 对话框", "days": 30 }
```

- 写在 `.d365/waivers.json`；`env` 支持 `*`，`object` 支持 `*` 与前缀 `x*`；
- 必须有过期时间（默认 30 天），过期自动重新出现在报告里；
- 报告显示「已豁免 N 条」，被豁免的条目不进阻断列表；
- 每次 drift 追加一条到 `.d365/reports/contract-history.json`（保留 60 条），下次跑同一组 `source → targets` 给出「新增 / 已消失」。

### 为什么读实时数据

插件注册规模：一个环境约 376 个程序集、6400 个类型、5900 个有步骤的类型（约 9.4 万条 step），几十秒读完。用几天前的快照做漂移会得出假结论，所以这里不用快照。

---

## 代码检查（d365_code_check）

读一次 MR，只分析它改到的文件。需要 GitLab 只读令牌（`read_api`），令牌所在用户至少 **Reporter**。

### JS / TS

检查链：改动文件 → 按**文件名**匹配环境里的 Web 资源（路径不一致时按同名候选取最接近的一个，报告里标「推断，待确认」）→ 找出引用该资源的表单 → 逐条比对改动行。

| 检查 | 结论 |
| --- | --- |
| 新增行读取的字段不在**任何**引用该库的表单上 | 阻断一次 |
| 字段只在部分表单上（脚本可能不会在这些表单走到该分支） | 警告，列出缺的表单（最多 3 个） |
| 引用的实体不存在（表单 `datafieldname`、`Xrm.WebApi` 的实体集） | 阻断 |
| 删除的函数仍被表单 Handler 引用 | 阻断 |
| 删掉的文件仍被表单引用 | 阻断（没有表单引用时不报） |
| `columns.get('x')` | 人工确认（视图/子网格列，不在表单字段里是正常的） |
| 带前缀的字符串下标 `["contoso_x"]` | 人工确认（静态判不出是字段还是普通键） |
| 新出现硬编码 GUID、选项值、环境地址 | 警告或人工确认 |
| 配置数据、字段级安全、运行用户权限 | 人工确认（静态判不了） |

取值写法覆盖：`getAttribute`、`getControl`、`attributes.get`、`formContext.data.entity.attributes.get`、`Xrm.Page.getAttribute`、`attributes[...]`、带前缀字符串下标。
只靠 `getAttribute` 一条正则会漏掉大量编译产物（实测一个 103 KB 的 TS 编译脚本命中 0 次），所以按写法分成三组：确定是字段、确定是列、需要人判。

### C# / 工程文件

按路径里**最靠内的工程目录**推断程序集名（`.csproj` 里有 `<AssemblyName>` 时以它为准）→ 与环境里的 `pluginassemblies` 做**精确匹配** → 查 `plugintypes`、`sdkmessageprocessingsteps`、`sdkmessageprocessingstepimages`。

| 检查 | 结论 |
| --- | --- |
| 程序集在目标环境不存在（共享工程如 `.Processes` 属于这种情况） | 警告 + 人工确认该文件最终随哪个程序集发布 |
| 源码版本与环境程序集版本不一致 | 警告 |
| `IPlugin` 类在目标环境没有对应插件类型 | 阻断 |
| 类型存在但没有任何步骤（改了也不会被触发） | 警告 |
| 代码读 `PreEntityImages["X"]` / `PostEntityImages["X"]`，对应步骤没注册该镜像 | 阻断（Create 步骤不检查 pre-image） |
| 步骤的 `filteringattributes` 引用该实体上不存在的字段 | 阻断 |
| 枚举 `contoso_*` 字面量在目标既不是表也不是全局选项集 | 人工确认 |
| 同一 `message\|stage` 上 ≥2 个步骤 | 警告（rank 重复时执行顺序不确定） |
| 代码用到 `secureConfig` / 构造函数两个 string 参数 | 人工确认（Web API 不返回 secure configuration 内容） |
| 沙箱可能禁止的 API（`System.IO`、`System.Net`、`Thread.Sleep`…） | 警告 |

程序集名只做精确匹配，不猜近似的——猜错会把类型/步骤核对到别的程序集上，比不核对更糟。

### 报告结构

```
改动文件表
每文件影响面（映射到哪个资源/程序集、哪些表单/类型）
阻断（必须修）
警告（建议修，或登记豁免）
人工确认（HC-01…，每条写清为什么机器判不了）
```

### 已知边界

- 只分析 MR 的增删行，不读仓库其它文件（不解析 import、不跟踪调用链）；
- 路径 → Web 资源名靠文件名推断，仓库路径与资源名不一致时会标「推断」；
- C# 的过滤属性、镜像、类型只看注册信息；secure/unsecure 配置内容与 rank 之外的隐式顺序仍需人工确认；
- 不判断运行用户权限与实际数据形态。

---

## 三类检查的分工

```
代码改动 ──d365_code_check──> 这次改动能不能上线（单次、面向 MR）
上游 vs 下游 ──d365_contract──> 环境之间的契约有没有破（持续、面向版本）
解决方案 ──d365_migrate──> 这次导入会不会压掉别人（单次、面向发布）
谁覆盖了它 ──d365_layers──> 为什么这个环境是现在这个样子
谁在用它 ──d365_refs──> 改/删它的影响面
```

它们不互相替代：`d365_layers` 告诉你「谁覆盖」，`d365_refs` 告诉你「谁引用」，`d365_code_check` 告诉你「这次改的行有没有落在不存在的东西上」。
