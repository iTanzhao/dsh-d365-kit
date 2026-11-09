# 结构与开发

**[English](../en/architecture.md)** | 简体中文

## 形态

一个 DSH bundle，两部分：

```
index.js      # Host 侧：注册 18 个工具、挂设置页的 HTTP 路由
client.js     # Web 侧：设置页（六个标签，无构建步骤，直接是浏览器模块）
lib/*.js      # Host 侧全部逻辑（41 个模块）
```

零运行时依赖：只用 Node 内置的 `fetch` / `fs` / `path`。没有 TypeScript、没有打包器、没有 `node_modules`。

`cordis.patch.yml` 声明 bundle 与默认配置（`configFile`、`timeoutMs`、`snapshotKeep`、`environments`）；
`package.json` 的 `dsh.bundle.patch` 指向它，`dsh.client` 声明 Web 侧入口。

## 模块分工

```
lib/
  client.js           Dataverse Web API 客户端：拼 URL、分页、重试、权限闸、令牌
  auth.js             Entra ID 客户端凭据流；令牌按凭据指纹缓存
  config.js           配置加载/归一化；configFile 回退链；密钥解析
  resources.js        19 类元数据资源的查询定义与字段映射
  runtime.js          makeClient(env, config)、组织信息、版本
  snapshot.js         快照写入、manifest、快照目录
  retention.js        保留策略、磁盘统计、清理、压缩
  write-policy.js     能力表（CAPABILITIES）与按环境的授权判定
  write-actions.js    全部写操作的 planner 与 executor（唯一改环境的代码）
  write-store.js      计划与变更记录的读写、计划状态机
  preflight.js        执行前空闲检查（msdyn_solutionhistories）
  settings-store.js   设置页的数据层（环境、权限、常规参数、GitLab）
  settings-http.js    设置页路由（认证 channel 上的精确路径）
  contract.js         契约事实读取、比对、渲染
  migrate.js          迁移评估（逐组件查层）
  code-check.js       MR 检查（JS/TS）
  csharp-check.js     MR 检查（C#）
  refs.js             反向索引（表单/视图/流程/步骤）
  health.js           环境健康
  gitlab.js           GitLab API（MR diff、连通性）
  waivers.js          契约豁免
  contract-history.js 漂移趋势
  data-migrate.js     业务记录跨环境迁移（计划、lookup 解析、写入、run 记录）
  tool-*.js           18 个工具，一个文件一个工具（或一组相关的）
```

## 数据流

```
agent 调 d365_*  ──> tool-*.js ──> lib 能力模块 ──> client.js ──> Dataverse Web API
                         │                                            │
                         └────────── 摘要 + 文件路径 <───────────────┘
                                        │
                                   .d365/{snapshots,diffs,reports,query,changes}
```

设计原则：

1. **工具返回摘要与路径，正文落文件**——对话里不塞几十 MB 的 JSON；
2. **只读优先**——只有 `d365_write execute` 与 `d365_data_write` 会改环境，且必须人批准；
3. **判定收在一处**——能看什么/能改什么都在 `lib/client.js` 的请求入口判定，新工具无法绕过；
4. **实时优于快照**——漂移、迁移、健康这类「现在怎么样」的问题读实时；快照只用于跨时间/跨环境比较；
5. **规则是数据**——契约规则、保留策略、能力表都是表驱动，加规则不改流程。

## 一次请求的路径

以 `d365_metadata resource=attributes` 为例：

```
tool-metadata.js
  → pickEnvironments(args)            选环境
  → loadConfig(state.rawConfig)       读配置（每个工具入口都做）
  → makeClient(env, config)           建客户端
  → resources.js 的查询定义            拼 path/params
  → client.getPagedWithSelectFallback 分页 + 列名降级
      → 权限闸（元数据实体集 → metadata.read；其余 GET → data.read；写 → data.write）
      → getAccessToken（按凭据指纹缓存）
      → fetch，429/5xx 按方法决定是否重试
  → 跨环境对齐 + 摘要
  → 超过 12 行写 .d365/query/*.json
```

## 加一个工具

```js
// lib/tool-demo.js
import { pickEnvironments } from './tool-metadata.js';   // 或自己实现

export default function registerDemo(ctx, state) {
  const disposer = ctx.tools.register({
    name: 'd365_demo',
    description: '一句话说明它回答什么问题。',
    parameters: {                    // 必须是标准 JSON Schema
      type: 'object',
      additionalProperties: false,
      required: ['entity'],
      properties: {
        entity: { type: 'string', description: '实体逻辑名' },
        environment: { type: 'string', description: '环境 key' },
      },
    },
    output: {
      schema: {                      // 同样必须是标准 JSON Schema
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
    },
    async execute(args, exec) {
      const config = await loadConfig(state.rawConfig);   // 注意：rawConfig
      ...
      return { text };
    },
  });
  ctx.effect(() => disposer);
}
```

然后 `index.js` 里 import、调用 `registerDemo(ctx, state)`、把 disposer 加进列表。

DSH 的硬性要求（都踩过）：

| 要求 | 症状 |
| --- | --- |
| `parameters` 与 `output.schema` 都是标准 JSON Schema（根节点 `type: 'object'`，`required` 是数组） | `schema must be a JSON Schema of 'type: "object"', got 'type: null'` |
| 输出严格符合 `output.schema`，不能多字段、不能 `type: ['string','null']` | `value.x is not a declared property` / `type arrays are not supported` |
| 配置从 `state.rawConfig` 取（`index.js` 传的是 `{ rawConfig }`） | 环境莫名不存在、列表为空 |
| Host 侧改完要重载插件 | 工具行为还是旧的 |

## 客户端（设置页）

`client.js` 是一个浏览器模块：`window.__ModuleLoader__.load({ id: 'dsh-d365-kit', factory })`。

- 六个标签的面板**同时挂载**，用 `display:none` 隐藏非活动页——切标签不丢编辑状态；
- 文案内置中英字典，`t()` 每次按 `localeService.getLocale().active` 现算，不依赖 `locale.register` 成功；
- 语言切换通过订阅 locale 变化触发重渲染；
- 所有写操作带 `x-d365-meta-write: 1`（Host 侧据此拒绝非设置页请求）。

**模块 id 必须与包名一致**，否则加载器会把它当两个模块执行两次，报 `duplicate factory registration` 并让整个设置页消失。

## 本地验证

没有环境也能测大部分逻辑：stub 掉 `globalThis.fetch` 与 `ctx.tools`，直接调模块函数。

```js
globalThis.fetch = async (url) => new Response(JSON.stringify({ value: [] }), { status: 200 });
```

注意：`new Response('', { status: 204 })` 在 Node 里会抛 `Invalid response status code 204`，204 要用 `null` body。

真实环境验证的最小集：

```
d365_envs check=true
d365_metadata resource=entities top=2
d365_layers component=account componentType=Entity
d365_health environments=["<env>"]
```

## 已知的坑（写给下一个改代码的人）

- 元数据端点不接受 `$top` / `$orderby`，客户端有渐进降级；写新查询时优先用 `getPagedWithSelectFallback`；
- `getPagedWithSelectFallback` 返回 `{ page, selectDropped, ... }`，行在 `result.page.records`；
- `odataString()` 只转义引号、**不包引号**，过滤器里要自己写 `'...'`；
- `client.getOne()` 会附加 `$top=1`，对 `solutions` / `solutioncomponents` 会 400，改用 `requestJson` 手动翻页；
- 层表、`msdyn_solutionhistories` 这类虚拟/审计表的行为与普通表不同，先小样本验证；
- 含非 ASCII 的文件不要用 PowerShell 5.1 的 `Get-Content | Set-Content` 改写（会按 ANSI 二次编码），用编辑工具；
- `package.json` 用 `Set-Content -Encoding utf8` 会写 BOM，`JSON.parse` 直接失败。
