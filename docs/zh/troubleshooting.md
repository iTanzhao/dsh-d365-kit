# 故障排查

**[English](../en/troubleshooting.md)** | 简体中文

## 先做这三件事

```
plugin_manager list_plugins
d365_envs check=true
d365_health allEnvironments=true
```

第一条看插件在不在、是否 active；第二条看凭据与网络；第三条看环境是不是正忙。多数「工具报错」能在这三步里定位。

---

## 错误码对照

| 错误 / 现象 | 含义 | 处理 |
| --- | --- | --- |
| `unknown-environment` | 环境 key 不存在 | `d365_envs` 看可用 key；设置页检查拼写 |
| AADSTS 系列 / `invalid_client` | 凭据错、secret 过期、应用未授权 | 重新生成 secret；确认应用用户在**这个**环境里存在 |
| `data-read-forbidden` | 该环境未授权读业务数据 | 设置页 → 权限 → 勾「读取业务数据」 |
| `data-write-forbidden` | 未授权写业务数据 | 勾「新增/修改业务数据」；每次写入仍需确认 |
| `environment-busy` | 环境正在导入/发布（`msdyn_solutionhistories` 有未结束记录） | 等它结束；确认是残留才用 `force: true` |
| `plan-not-pending` | 计划正在执行 / 上次中断 / 已执行过 | 重新生成计划；写操作不是幂等的，不要重跑旧计划 |
| `unknown-solution` / `managed-solution` | 默认解决方案不存在或是受管的 | 换一个**已存在的未受管**解决方案 |
| `destructive-not-acknowledged` | 删除字段/选项值没传 `acknowledge: true` | 明确确认后再传 |
| `option-set-unreadable` | 字段的本地选项集读不出来（类型转换都失败） | 确认该字段确实是选项集；看返回里的 hint |
| `unknown-view` / `ambiguous-view` | 视图名不存在 / 同名多个 | 传 `entity` 区分 |
| `HTTP 400 … Could not find a property named` | 该环境没有这个列，或列名不适配此端点 | 工具会尝试降级；仍失败时用 `select` 显式指定存在的列 |
| `0x80060888 … query parameter is not supported` | 端点不接受该参数（如 `EntityDefinitions` 的 `$top`/`$orderby`） | 客户端已自动降级；自己写脚本时注意 |
| `0x80071151` | 定制化锁被占用（正在导入/发布） | 用 `d365_health` 确认，等结束；别反复重试 |
| `HTTP 429` | 服务保护（约 6000 请求/5 分钟） | 降并发（`concurrency` ≤ 4）、稍后重试；写请求只在 429 时自动重试 |
| 发布 60–300 秒超时 | `PublishAllXml` 在两千多张表的组织上很慢 | 已改为按受影响组件 `PublishXml`；仍超时看 `d365_health` |
| `GitLab 403` | 令牌 scope 不足，或用户在项目里低于 Reporter | 换个人访问令牌或提升角色；Guest 读不到仓库与 MR |
| `GitLab 404` | 项目路径或 IID 错，或令牌看不到该项目 | 用完整 MR 链接，或填默认项目 |

---

## 安装 / 加载问题

### 工具没出现

1. `plugin_manager list_plugins` 找 `include:dsh-d365-kit`，确认 `enabled=true`、`fiberPhase=active`；
2. 刚装完要重启 DSH（Web 客户端插件有模块图缓存）；
3. 若条目不存在：`remove_bundle` 再 `install_bundle`（link/pnpm 认为包已存在时只会返回 `already-installed`，不会替换代码）。

### 重启报 `duplicate factory registration` / `import failed`

同一个 bundle 被执行了两次。检查两处名字是否与包名一致：

- `client.js` 顶部的 `window.__ModuleLoader__.load({ id: ... })`
- `index.js` 的 `export const name = ...`

改名或改包名时容易漏掉这两个「自报名字」。仍然复现的话，完全退出 DSH 后删 Electron 的编译缓存再启动：

```
%APPDATA%\@deepseek-ai\dsh-desktop\Code Cache
%APPDATA%\@deepseek-ai\dsh-desktop\Local Storage
%APPDATA%\@deepseek-ai\dsh-desktop\Session Storage
%APPDATA%\@deepseek-ai\dsh-desktop\Cache
%APPDATA%\@deepseek-ai\dsh-desktop\GPUCache
```

只丢界面偏好，不动 `.dsh` 里的会话与配置。

### 设置页没有「D365 工具箱」

Host 侧可能已加载、客户端半边没进模块图：重启一次。仍没有就查 `client.js` 的模块 id 与包名是否一致（同上）。

---

## 设置页报错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 保存权限报「写入只能从设置页发起」 | 请求缺 `x-d365-meta-write: 1`，或来自别的源 | 只在设置页里操作；被拒记录见 `.d365/write-guard.log` |
| 某个标签打开报 `HTTP 400` 且没有详细信息 | 路由未声明请求体模式，连接层构造了带 body 的 GET | 升级到 0.18.0+（已修）；旧 bundle 需重启 |
| 保存后配置没变 | `configFile` 指向了另一个位置 | 设置页底部会显示配置文件路径；用 `D365_CONFIG_FILE` 或 patch 固定 |
| 中文界面出现英文 | DSH 界面语言是英文 | 正常行为：页面文案跟随 DSH |

---

## 数据问题

### 层查询返回 0 行

`msdyn_componentlayer` 是虚拟实体，**必须同时给组件 id 和类型**。只给名字、只给 id、不带过滤，都会静默返回 0 行（不报错）。

部分环境里该表能读，但应用用户看不到数据，需要管理员身份。

### 快照很大

单份全量约 125 MB（20 万条 solution components、9.4 万条插件步骤、6.6 万个 Web 资源）。默认每环境留 2 份；`d365_reports action=compact` 可把缩进 JSON 压成单行（实测省 68 MB）。

### 差异报告噪声大

先用 `resources` 限定范围；`organization` 默认已跳过，时间戳与 `*id` 列不参与比较。跨环境比较请用逻辑名。

---

## 写入问题

### 计划执行后报「计划不存在」

执行成功后会删除计划文件。再次点旧卡片或重复执行会得到这个提示；到设置页「计划」看最近变更记录确认结果。

### 写入成功但下游看不到

1. 改动是不是进了活动默认层？填「变更默认解决方案」，否则导出解决方案带不走；
2. 下游有没有被别的受管解决方案的层盖住？`d365_layers` 看；
3. 有没有发布？写入会自动发布受影响组件，结果看 `.d365/changes/publish-<planId>.json`。

### 发布一直 `running`

发布在后台进行，sidecar 文件在结束时才写。看 `d365_health` 里该环境是否仍在发布；确认没有活动后重跑一次 `PublishXml` 即可，发布本身是幂等的（重复发布不改变结果）。

---

## 还是解决不了

收集这些再问：

```
d365_envs
d365_health environments=["<那个环境>"]
```

加上报错的完整文本、时间点，以及 `.d365/write-guard.log`（设置页写入问题时）。
