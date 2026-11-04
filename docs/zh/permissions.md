# 权限与写入

**[English](../en/permissions.md)** | 简体中文

## 默认姿态

装好之后是**只读，而且只读元数据**：

- 元数据（实体、字段、表单、视图、插件、解决方案、层、站点地图…）随时可读；
- **业务记录**默认读不到，需要按环境授权 `data.read`；
- 任何修改都需要按环境授权对应能力，且每次执行要人确认。

「能看什么」和「能改什么」放在同一份按环境的能力表里，因为这两件事本来就该一起管。

## 能力表

配置在 `d365.config.json`：

```json
{
  "write": {
    "environments": {
      "dev": ["data.read", "optionValue.add", "attribute.add", "view.columns"],
      "sit": ["data.read"],
      "uat": []
    },
    "solutionUniqueName": "ContosoBase"
  }
}
```

| 能力 | 真实 HTTP 操作 | 分组 | 作用 |
| --- | --- | --- | --- |
| `data.read` | 任意 `GET` | 数据 | 读取业务记录 |
| `data.write` | `POST` / `PATCH` | 数据 | 新建或修改业务记录（高危，不含删除） |
| `optionValue.add` | `InsertOptionValue` | 选项集 | 新增选项值（全局或字段本地） |
| `optionValue.updateLabel` | `UpdateOptionValue` | 选项集 | 改选项标签 |
| `optionValue.delete` | `DeleteOptionValue` | 选项集 | **永久删除**选项值（高危） |
| `attribute.add` | `POST EntityDefinitions(...)/Attributes` | 字段 | 新增字段 |
| `attribute.update` | `PUT` 字段 URL（`MSCRM.MergeLabels`） | 字段 | 改显示名、描述、必填级别 |
| `attribute.delete` | `DELETE` 字段 URL | 字段 | **永久删除**字段及其数据（高危） |
| `entity.update` | `PUT` 实体 URL（`MSCRM.MergeLabels`） | 表 | 改表显示名与描述 |
| `view.columns` | `PATCH savedqueries(id)` | 视图 | 在系统视图里增删列（只改 `layoutxml`） |

设置页「权限」里按环境勾选，支持「复制到其他环境」。

## 两道数据闸

判定收在 `lib/client.js` 一处，新增工具绕不过去：

- **读**：请求 URL 的实体集名不在元数据白名单（`EntityDefinitions`、`systemforms`、`savedqueries`、`webresourceset`、`solutions`、`msdyn_componentlayers`…）里，一律按业务数据拦截，报 `data-read-forbidden`；
- **写**：非 `GET` 且不属于元数据消息（`PublishXml`、`InsertOptionValue`、`CreateAttribute`…）的请求，先要求 `data.write`，否则报 `data-write-forbidden`。

拦截都发生在**取令牌之前**，不会把请求发到环境里。

## 两步写入

### 第一步：生成计划（只读）

`plan-*` 会读现状、跳过无变化项，把操作写成计划文件（`.d365/pending-writes/`），返回操作列表。

| 计划 | 约束 |
| --- | --- |
| `plan-add-options` | 按 `\|` 前的代码去重；新值从当前最大值 +1 顺延；已存在的代码进 `skipped` |
| `plan-relabel` | 只把标签确实变化的项放进计划 |
| `plan-option-delete` | 必须 `acknowledge: true`；不存在的值进 `skipped`，已有记录引用时 Dataverse 会拒绝 |
| `plan-add-attribute` | 表必须存在、字段必须不存在；`SchemaName` 必须带发布者前缀 |
| `plan-update-attribute` | 只放真正变化的项 |
| `plan-delete-attribute` | 必须 `acknowledge: true`，否则直接拒绝 |
| `plan-update-entity` | 只改显示名 / 描述 |
| `plan-view-columns` | 按视图名定位系统视图（同名用 `entity` 区分）；只改 `layoutxml` 的 cell 列表，不动筛选条件 |

局部选项集（字段自带的选项集）用 `entity` + `attribute` 指定，全局选项集用 `optionSet`。

### 第二步：执行（要人）

```
执行 mw04aul6-1ci6aa
```

agent 调 `d365_write action=execute planId=...`，会：

1. 读计划，检查状态必须是 `pending`；
2. 检查该环境**现在**仍持有这项能力；
3. 查环境是否正在导入/发布（见下）；
4. 弹确认卡片：环境、目标、操作条数、前 10 条操作；含删除时额外提示不可恢复；
5. 点「批准执行」→ 逐条写入 → 后台发布 → 记审计。

也可以到设置页「计划」标签里审阅并执行（同样的二次红色确认）。两条入口共用同一套校验。

### 计划状态

`pending → running → done / failed`

第一次写入前就落 `running`，所以进程中途被杀不会留下一个「看起来还能点」的计划。非 `pending` 的计划，工具与设置页**都拒绝**执行和取消——写操作不是幂等的，重跑会重复提交已经生效的部分。要重做必须重新生成计划。

### 执行前检查

Dataverse 在导入或发布期间持有定制化锁。微软第一方更新就是以解决方案导入形式进来的，一个环境一天里很大一部分时间在做这件事——此时写入要么 `0x80071151`，要么一直等锁直到超时。

所以执行前查 `msdyn_solutionhistories` 里 `msdyn_endtime` 为空的行：

| 情况 | 行为 |
| --- | --- |
| 有记录且开始时间在 `busyWindowMinutes`（默认 120 分钟）内 | 拒绝执行，报出正在进行的操作（`environment-busy`） |
| 只有更早的记录（残留僵尸行） | 不阻塞，结果里提示一句 |
| 查不到表（没权限） | 跳过检查，结果注明没检查成 |

`force: true` 可跳过，只在确认是残留时用。

### 默认解决方案

每次元数据修改都记在某个**解决方案层**里。不指定时进活动默认层（Default Solution），导出解决方案带不走，下游表现为「字段不存在」。

所以建议填「变更默认解决方案」：一个**已存在的未受管**解决方案唯一名。计划阶段就校验——名字不存在报 `unknown-solution`，受管报 `managed-solution`，不用等到执行才失败。

### 发布范围

写完只发布**受影响的组件**：

- 选项集操作 → 对应选项集（本地选项集 → 所属表）；
- 字段 / 表 / 视图操作 → 所属表。

负载形如：

```xml
<importexportxml>
  <entities><entity>account</entity></entities>
  <optionsets><optionset>contoso_taxcategoryos</optionset></optionsets>
</importexportxml>
```

一次发布是秒级到十几秒，而不是 `PublishAllXml` 把两千多张表重算一遍的分钟级操作。推不出受影响组件时才退回全量发布。发布在后台进行，结果写 `.d365/changes/publish-<planId>.json`；执行返回里会带 `publishState`（`skipped` / `running`）。

## 业务数据写入

`d365_data_write` 的三条约束：

- 需要 `data.write`，默认关闭；
- 只能写**一个**环境；
- 每次弹确认卡片，批准才发请求。

写入不需要发布（业务数据不是元数据）。审计只记字段名、不落值。没有删除。

## 安全边界

- **写接口只接受设置页**：`/write/policy`、`/write/cancel`、`/write/execute`、`/write/publish` 要求 `x-d365-meta-write: 1` 头。跨站页面要带这个头必须过 CORS 预检，而这些路由不回应预检；若请求里有 `Origin`，还必须同源。认证通道会把 URL 改写成 `http://dsh.internal` 并吞掉 `Origin`，所以不能只靠 Origin 判断。被拒的请求记 `.d365/write-guard.log`。
- **重试只对安全方法**：`GET`/`HEAD` 在网络错误与 5xx 上重试；`POST`/`PATCH`/`DELETE` 只在 **429**（服务端明确没执行）时重试。写入超时按「可能已生效」报错，让人去环境核对，而不是悄悄重发。
- **重新发布也要过门槛**：该环境必须仍持有当时那项能力，且先做一次空闲检查（忙时返回 409，而不是原始 429）。
- **取消与执行一样拒绝非 `pending`**：不会出现「页面说取消了、后台还在写」。
- **不可回滚**：元数据删除不可恢复，所以删除必须 `acknowledge: true`，卡片上还会单独提示。
- 写接口不提供批量脚本入口，也没有「跳过确认」的开关；`force` 只跳过空闲检查，不跳过确认。
