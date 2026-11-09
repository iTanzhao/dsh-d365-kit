---
name: d365-troubleshooting
description: 用 dsh-d365-kit 排查 Dynamics 365 / Dataverse 插件失败：插件报错、跟踪日志、步骤注册、消息复现、异步作业。Use when a D365 plug-in, custom action, flow or async job fails and you need to find the cause with the d365_* tools.
---

# 排查 D365 插件失败

## 什么时候用

插件抛异常、自定义消息返回 400/500、某个表上的同步逻辑突然不动、异步作业积压——任何「元数据看起来对，但运行时不对」的问题。目标不是读一堆日志，而是**尽快拿到一个签名 + 一个可复现的调用**。

## 先确认三件事（30 秒，别跳）

1. **哪个环境**：`d365_envs` 看配置与连通性。环境搞错是最常见的假故障。
2. **权限够不够**：跟踪日志属于业务数据，要 `data.read`；调 POST 消息要 `message.invoke`（默认关）。
3. **跟踪有没有开**：`d365_health` 的「插件跟踪」列 = 关闭 / 仅异常 / 全部。列显示「关闭」时，任何 trace 查询都查不到东西——先让环境开起来，再谈排查。

## 排查顺序

### 1. 先看是不是异步作业，而不是插件

```json
{ "environments": ["sit"], "hours": 48 }
```

`d365_health` 的挂起 / 近期失败（Completed 且 Failed）指向 `asyncoperation`。异步作业失败**不会**写插件跟踪日志，这两条线不要混。

### 2. 归并签名：几百条失败通常是同一个 bug

```json
{ "action": "summary", "hours": 24, "entity": "contact" }
```

`d365_trace summary` 按「插件类型 + 消息 + 表 + 异常首行」归并。签名一样 = 同一个 bug 在反复发生，接着只查一条就够。

### 3. 取一条完整调用

```json
{ "action": "list", "typename": "ContactSearch", "hours": 24, "top": 20 }
{ "action": "get", "traceId": "<上一步的 id>" }
```

`get` 给异常全文 + messageblock（入参）。messageblock 里有 `secureConfig` 的明文密钥，工具会屏蔽成 `***`——**不要**为了「看得清楚」去开 `includeConfig`。

### 4. 步骤到底注册在哪

```json
{ "resource": "plugin_steps", "top": 1000, "filter": "contains(typename,'ContactSearch')" }
{ "resource": "step_images", "top": 200 }
```

看三样：`message`（Create / Update / RetrieveMultiple）、`stage`（20 前 / 40 后）、`mode`（同步 0 / 异步 1），以及 `filteringattributes`。步骤存在但没触发，九成是这三项之一不对，而不是代码不对。

### 5. 复现那条消息

```json
{ "message": "contoso_Recalculate", "method": "POST", "entity": "accounts",
  "id": "<guid>", "parameters": { "Target": { "@odata.type": "Microsoft.Dynamics.CRM.account" } } }
```

`d365_invoke` **失败不抛异常**，会把 HTTP 状态、Dataverse 错误码和响应体原样给你——这正是插件抛出的原始形状。GET function 走 `data.read`，POST action 走 `message.invoke`，每次都会弹确认卡片。

### 6. 需要时再往下挖

- 数据是否符合预期：`d365_data { "action": "query", "entity": "contact", "filter": "..." }`
- 谁引用了这个字段/脚本/程序集：`d365_refs`
- 一个环境有、另一个环境没有：`d365_contract`（插件步骤/程序集版本漂移）、`d365_layers`（谁盖住了谁）
- 元数据本身对不上：`d365_metadata resource=attributes ... cast=...`（`DefaultValue`、`OptionSet`、`Targets` 必须先 cast）

## 错误码速查

| 错误码 | 通常意味着 | 下一步 |
| --- | --- | --- |
| `0x80048d19` | 请求体形状不对：把 lookup 写成了裸 GUID，而不是 `字段@odata.bind`（而且键要用导航属性名） | 查 `RelationshipDefinitions` 的 `ReferencingEntityNavigationPropertyName` |
| `0x80040216` / `0x80040217` | 引用的记录不存在（常见于跨环境复制后 GUID 不匹配） | `d365_data query id=...` 确认；迁移用 `plan` 的 lookup 报告 |
| `0x80040333` | 重复检测规则拦下 | 确认是不是真重复；批量写时再考虑 `MSCRM.SuppressDuplicateDetection` |
| `0x80044150` | 并发冲突（别人同时改了同一条） | 重试单条，不要盲目放大并发 |
| `0x80048423` | 受管组件不可改 | 在未受管解决方案里改，别碰受管层 |
| `0x8004a0f6` | 状态机不允许这次状态转换 | 走对应消息（如 `CloseIncident`），不要直接改 statuscode |
| `0x80060888` | 属性名或查询参数不被这个端点支持 | 元数据端点大多不支持 `$filter`/`$orderby`/`$top`；派生列要 cast |

## 三个真实踩过的坑

- **成功执行的 trace 存空串，不是 null**。只写 `exceptiondetails ne null` 会把成功执行也列成失败——至少多算了 3 倍。`d365_trace` 默认已经排除。
- **`$count` 在 5000 截断**，`d365_metadata` 显示「≥5000」不是 bug，是服务端上限。要精确总数就分组或加条件。
- **元数据读和业务数据读是两道闸**：`metadata.read` 默认开，`data.read` 默认关。查 trace 被拒时看的是 `data.read`，不是元数据那一道。

## 不要做的事

- 不要连生产环境试 `execute`/`invoke`；先用 DEV，只读动作先跑。
- 不要把 messageblock 原样贴进工单——里面有 `ClientSecret`。
- 不要因为「步骤没日志」就断定插件没跑：先看跟踪级别，再看异步作业。
- 不要绕过工具手写 OData/PowerShell 复现：一次 `d365_invoke` 比 15 次 `Invoke-RestMethod` 快，而且不会踩编码与 `$ErrorActionPreference` 的坑。
