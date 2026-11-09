# dsh-d365-kit（D365 工具箱）

**[English](README.md)** | 简体中文

Dynamics 365 CE / Dataverse 的**开发与部署助手**，作为 [DeepSeek Harness](https://github.com/deepseek-ai) 的 bundle 安装。
它把一个真实的 D365 组织变成 agent 能直接查的东西：元数据、解决方案层、快照差异、引用关系、迁移风险、代码改动的影响面，以及受控的写入。

> 十六个工具、一个设置页。默认只读：勾选什么就只做什么，元数据也由「读取元数据」这一项控制（默认开启）。

```
你：DEV 的 account 上 contoso_customertier 这个字段，现在还有哪些表单和视图在用它？
agent：表单 17 张、视图 64 个（列 62 / 筛选 50）、业务流程 0 个 …
```

---

## 它解决什么问题

D365 项目的日常摩擦，大多不是"不会写代码"，而是**环境之间的信息不对称**：

| 问题 | 这个插件怎么答 |
| --- | --- |
| 这个解决方案发到 SIT，会不会把别的解决方案的定制压掉？ | `d365_migrate` 逐组件查层，列出会被遮蔽的解决方案、缺失的组件、会丢的选项值 |
| 为什么两个环境的同一张表单不一样？ | `d365_layers` 告诉你是谁覆盖了它，`d365_diff` 给出字段级差异 |
| 删这个字段会不会出事？ | `d365_refs` 反查表单 / 视图 / 流程 / 插件步骤，`d365_data` 看还有多少条记录在用 |
| 这个 MR 发布到 UAT 能跑起来吗？ | `d365_code_check` 把 JS 映射到 Web 资源与表单、把 C# 映射到程序集/类型/步骤/镜像 |
| 上游改了插件，下游跟上了吗？ | `d365_contract` 把上游注册当契约，逐条比对下游，带豁免与趋势 |
| 现在能发布吗？ | `d365_health` 看挂起的导入/发布与失败作业，写入前的预检查用的是同一份数据 |
| 补一个字段 / 选项值 / 视图列？ | `d365_write` 生成计划 → 人在对话里确认 → 才写入，事后可查审计 |

---

## 功能一览

### 连接与环境

| 工具 | 用途 |
| --- | --- |
| `d365_envs` | 环境清单、凭据是否齐全；`check: true` 时真实连一次 |
| `d365_configure` | 增删改环境（URL、租户、ClientId、密钥）、测连通性 |
| `d365_health` | 挂起/失败的后台作业、正在进行的导入发布、最近安装的解决方案 |

### 元数据与解决方案层

| 工具 | 用途 |
| --- | --- |
| `d365_metadata` | 19 类资源：实体、字段、关系、表单、视图、工作流、业务规则、插件、Web 资源、解决方案、组件、Custom API、站点地图、选项集 |
| `d365_layers` | `msdyn_componentlayer`：某组件被哪些解决方案覆盖过、谁在最上层、当前生效的是哪一层 |

### 快照与对比

| 工具 | 用途 |
| --- | --- |
| `d365_sync` | 把环境的元数据拉成本地快照，逐资源记录「完整 / 被截断 / 失败」 |
| `d365_diff` | 两份快照的字段级差异（新增、删除、修改），带噪声过滤与快照过期提示 |

### 影响面与数据

| 工具 | 用途 |
| --- | --- |
| `d365_refs` | 反查：字段 → 表单/视图/流程；Web 资源 → 表单与事件；程序集 → 类型与步骤 |
| `d365_data` | 业务记录 count / group by / sample（需授权 `data.read`） |
| `d365_data_write` | 新建或修改一条业务记录，对话确认后执行（需 `data.write`） |

### 写入

| 工具 | 用途 |
| --- | --- |
| `d365_write` | 选项集增/改/删值、新增/改/删字段、改表显示名、增删系统视图列；`plan-*` 只出计划，`execute` 必须人工确认 |

### 迁移与检查

| 工具 | 用途 |
| --- | --- |
| `d365_migrate` | 解决方案迁移风险评估：层遮蔽、组件缺失、选项值丢失、版本与受管状态 |
| `d365_contract` | 契约矩阵与漂移：程序集、插件类型、步骤、表单库、Handler、站点地图、选项值；带豁免与趋势 |
| `d365_code_check` | 读 GitLab MR，JS/C# 改动 → 目标环境核对，输出阻断 / 警告 / 人工确认 |

### 运维

| 工具 | 用途 |
| --- | --- |
| `d365_reports` | 本机产物与占用、按保留策略清理（默认预演）、压缩快照 |

---

## 设置页

DSH Web UI 的「设置 → D365 工具箱」，六个标签页：

| 标签 | 内容 |
| --- | --- |
| 环境 | 环境清单、测试连接、默认环境 |
| 权限 | 按环境勾选能力（读业务数据 / 写入类）、变更默认解决方案、复制到其它环境 |
| 计划 | 待确认的写入计划、最近的变更记录与发布结果（可重新发布） |
| 数据 | 每类产物的文件数 / 体积 / 保留策略，预演并清理，压缩快照 |
| GitLab | 仓库地址、默认项目、只读令牌（`read_api`） |
| 常规 | 快照保留份数、默认行数上限、请求超时 |

界面语言跟随 DSH（中文 / English）。环境清单与 `d365_configure` 走同一份存储代码，界面和 agent 看到的一定一致。

---

## 安装

前置：DSH 桌面版；机器能访问 `*.dynamics.com`；一个只读应用用户（ClientId + 密钥）。

```bash
# 从 npm 安装（最短，可升级；包发布到 npm 或内网 registry 后可用）
plugin_manager install_bundle target="dsh-d365-kit@0.30.0"

# 从 Git 安装（不需要 registry，可钉 tag）
plugin_manager install_bundle target="git+https://<your-git>/<group>/dsh-d365-kit.git#v0.30.0"

# 或从本地目录安装（link，改代码立刻生效）
plugin_manager install_bundle target="D:\path\to\dsh-d365-kit"
```

`dsh-d365-kit@<版本>` 是从 **npm registry** 解析的；只发到 GitHub 时，用第二条的 `git+https://` 形式装。仓库里带 `.github/workflows/publish.yml`，配好 `NPM_TOKEN` 后推 `v*` tag 就会自动发 npm。

装完**重启一次 DSH**，Web 客户端才会把设置页代码加载进模块图。

然后：设置 → D365 工具箱 → 环境 → 添加环境（key、URL、租户、ClientId、密钥）→ 测试连接 → 保存。
默认只读；要读业务记录，去「权限」勾「读取业务数据」。

完整步骤、凭据解析顺序、升级与卸载见 [docs/installation.md](docs/zh/installation.md)。

---

## 典型用法

### 1. 发布前评估一个解决方案

```
这个解决方案发到 SIT 和 UAT 有什么风险？

d365_migrate action=assess source=dev solution=ContosoBase targets=["sit","uat"]
```

报告回答：目标有没有这个解决方案、源版本是不是更高、每个组件的层会被谁压住（列出被遮蔽的解决方案）、选项集会不会丢值。落在 `.d365/reports/migration-*.md`。

### 2. 这个字段能删吗

```
account.contoso_customertier 还有谁在用？顺便看下还有多少条记录带着值。

d365_refs   kind=field entity=account attribute=contoso_customertier
d365_data   action=group entity=account field=contoso_customertier
```

### 3. 两个环境为什么不一样

```
d365_sync environments=["dev","sit"]
d365_diff base=dev head=sit resources=["forms","views","attributes"]
d365_layers component=Account componentType=SystemForm
```

### 4. 检查一个 MR 能不能发到 UAT

```
d365_code_check mergeRequest="https://gitlab.example.com/contoso/powerapps/-/merge_requests/7759/diffs" targets=["uat"]
```

JS 改动会映射到 Web 资源与表单，检查读取的字段是否在表单上、删除的函数是否仍被 Handler 引用；
C# 改动会核对程序集版本、插件类型、步骤、step 镜像与过滤属性。静态判不了的进「人工确认」清单。

### 5. 补 36 个税号选项（写入全流程）

```
d365_write action=plan-add-options environment=dev optionSet=contoso_taxcategoryos labels=["AD3|Andorra: Tax Register Number", ...]

（agent 返回计划与操作列表）
执行 mw04aul6-1ci6aa
```

第二步会在对话里弹确认卡片，点「批准执行」才写入；写入后只发布受影响的那个选项集，不重算整个组织。

### 6. 上游插件改了，下游还缺什么

```
d365_contract action=drift source=dev targets=["sit","uat"] forms=true
```

更多可直接复制的说法见 [examples/prompts.md](examples/prompts.zh-CN.md) 与 [docs/scenarios.md](docs/zh/scenarios.md)。

---

## 权限模型

默认**只读**。能力按环境授权，存在 `d365.config.json` 的 `write.environments`；设置页里每个环境单独一块，用分隔线隔开：

```json
{
  "write": {
    "capabilityVersion": 2,
    "environments": {
      "dev": ["metadata.read", "data.read", "optionValue.add", "attribute.add"],
      "sit": ["metadata.read", "data.read"]
    },
    "solutionUniqueName": "ContosoBase"
  }
}
```

环境没有条目 = 还没配过，默认只开 `metadata.read`；条目是空数组 = 全关。

| 能力 | 对应操作 | 作用 |
| --- | --- | --- |
| `metadata.read` | 元数据 `GET` | 读表 / 字段 / 表单 / 视图 / 插件 / 层（默认开启） |
| `data.read` | 业务数据 `GET` | 读业务记录；不授权时读不到表里的记录 |
| `data.write` | `POST` / `PATCH` | 新建或修改业务记录（不含删除） |
| `optionValue.add` | `InsertOptionValue` | 新增选项值（全局或字段本地） |
| `optionValue.updateLabel` | `UpdateOptionValue` | 改选项标签 |
| `optionValue.delete` | `DeleteOptionValue` | 永久删除选项值（高危） |
| `attribute.add` | `CreateAttribute` | 新增字段 |
| `attribute.update` | `UpdateAttribute` | 改字段显示名 / 描述 / 必填级别 |
| `attribute.delete` | `DeleteAttribute` | 永久删除字段及其数据（高危） |
| `entity.update` | `UpdateEntity` | 改表显示名与描述 |
| `view.columns` | `UpdateSavedQuery` | 增删系统视图的列 |
| `layer.remove` | `RemoveActiveCustomizations` | 移除组件最上面的未受管自定义层（高危） |

写入是两步：`plan-*` 只读生成计划 → 人在对话（或设置页）确认后 `execute`。执行前会查环境是否正在导入/发布，忙则拒绝；每次执行逐条记进 `.d365/changes/`，计划有 `pending → running → done/failed` 状态，重跑不会重复提交。

判定收在 `lib/client.js` 一处：先看是不是元数据请求（要 `metadata.read`），其余 `GET` 一律按业务数据拦截（要 `data.read`），非 `GET` 的写还要 `data.write`。拦截发生在取令牌之前，新增工具绕不过这三道闸。

详见 [docs/permissions.md](docs/zh/permissions.md)。

---

## 本地产物

```
<工作区>/
  d365.config.json          # 环境清单与工具参数（可进 Git）
  d365.secrets.json         # 客户端密钥（明文，别提交）
  .d365/
    snapshots/<env>/<id>/   # 元数据快照 + manifest
    diffs/                  # 对比报告
    reports/                # 迁移、契约、代码检查、历史趋势
    query/                  # 查询留证、数据写入审计
    pending-writes/         # 待确认计划
    changes/                # 已执行的变更与发布结果
    waivers.json            # 契约豁免
```

`.d365/` 自带 `.gitignore`（内容 `*`）。保留策略默认：快照 2 份/30 天、报告 50/90、diff 20/30、query 100/7、changes 200/180，写产物后自动清理，`waivers.json` 与待确认计划永不清理。

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/installation.md](docs/zh/installation.md) | 安装、首次配置、凭据、升级、卸载 |
| [docs/tools.md](docs/zh/tools.md) | 18 个工具的参数、返回与示例 |
| [docs/scenarios.md](docs/zh/scenarios.md) | 8 个真实场景的完整走法 |
| [docs/permissions.md](docs/zh/permissions.md) | 能力表、写入流程、预检查、安全边界 |
| [docs/checks.md](docs/zh/checks.md) | 迁移评估、契约漂移、代码检查的规则与置信度 |
| [docs/troubleshooting.md](docs/zh/troubleshooting.md) | 常见错误码与排查 |
| [docs/architecture.md](docs/zh/architecture.md) | 模块结构、数据流、如何加一个工具 |
| [CHANGELOG.md](CHANGELOG.zh-CN.md) | 版本记录 |

---

## 已知边界

- 不采 Ribbon 与 Power Automate 云流。
- `attributes` 按实体逐个请求，实体多时请求量等于实体数；用 `entities` 缩小范围。
- 元数据表基本没有增量游标，每次同步都是全量；增量只能「跑第二次然后 diff」。
- `d365_layers` 依赖 `msdyn_componentlayer` 虚拟表：必须同时给组件 id 与类型，只给名字返回 0 行。
- 组件类型 36 / 50 / 70（报表、图表类）在层表里没有对应名称，只做存在性检查。
- 层叠顺序由**导入时间**决定，与版本号无关：谁后导入谁在上。
- `secureconfiguration` 经 Web API 读回恒为空，插件 secure config 只能人工确认。
- 契约漂移读实时数据（不是快照），环境大时一次几十秒到几分钟。

---

## 开发

```
index.js              # Host 入口：注册 18 个工具、挂设置页路由
client.js             # 设置页（六个标签，无构建步骤）
lib/
  client.js           # Dataverse Web API 客户端（重试、分页、权限闸）
  auth.js             # Entra ID 客户端凭据流 + 令牌缓存
  config.js           # 配置加载与归一化
  resources.js        # 19 类元数据资源的查询定义
  write-actions.js    # 全部写操作的 planner / executor
  contract.js         # 契约矩阵与漂移规则
  migrate.js          # 迁移评估
  code-check.js       # MR 检查（JS）
  csharp-check.js     # MR 检查（C#）
  refs.js             # 反向索引
  retention.js        # 保留策略与磁盘清理
  ...
```

零运行时依赖：只用 Node 内置的 `fetch` / `fs` / `path`。改完用 `node --check` 逐个文件验证；Host 侧改动需要重载插件才会生效（`plugin_manager set_plugin enabled=false` 再 `true`），客户端代码需要刷新页面。

新增工具的约定：`parameters` 与 `output.schema` 都写标准 JSON Schema；返回「摘要 + 文件路径」，正文落文件；注册后加入 `index.js` 的 disposers。

---

## 状态

内部工具，按项目需要演进。版本语义：修 bug 升 patch，加工具/加能力升 minor，改配置结构升 major。

不随包提供环境配置与密钥；`d365.config.json` 与 `d365.secrets.json` 由每台机器自己填。

---

## 许可证

[MIT](LICENSE) © 2026 iTanzhao

可以随意使用、修改、分发，保留版权声明即可。不提供担保，也不授予商标使用权。
