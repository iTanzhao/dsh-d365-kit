# 安装与配置

**[English](../en/installation.md)** | 简体中文

## 前置

| 项 | 要求 |
| --- | --- |
| DSH | 桌面版，能打开 Web GUI（设置页是 Web 客户端插件） |
| 网络 | 能访问环境域名（`*.crm*.dynamics.com` 或对应区域）与登录端点 |
| 应用用户 | Entra ID 里的应用注册 + 在 Dataverse 里建的应用用户，拿到 `ClientId` / `ClientSecret` / `TenantId` |
| 权限 | 读元数据、读解决方案（`prvReadSolution`）、读自定义 API（`prvReadCustomAPI`）、读层表（`prvReadmsdyn_componentlayer`） |

只读应用用户就够用；写入能力用到的 `CreateAttribute` 等消息，需要该用户在环境里有对应权限（系统定制员或自定义角色里勾相应权限）。

> 应用用户在一个环境里建好后，要在**每个**目标环境各建一次（同一个 ClientId 可以复用）。

## 安装

### 方式一：从 npm 安装（最短）

```bash
plugin_manager install_bundle target="dsh-d365-kit@0.29.0"
```

前提是包已经发到 pnpm 配置的 registry——公网 npm 或内网镜像都行。包名没有 scope，不需要配 scope 映射。要装指定版本就写 `dsh-d365-kit@<版本>`。

> **只发 GitHub 不等于发了 npm。** 仓库可以直接用第二种 `git+https://...` 装，`npm install github:<user>/<repo>#<tag>` 也能装；但 `install_bundle target="dsh-d365-kit"` 只有在包进了 registry 之后才解析得到。仓库里带 `.github/workflows/publish.yml`：配好 `NPM_TOKEN` secret，推 `v*` tag 就自动发布。

### 方式二：从 Git 安装（不需要 registry）

```bash
plugin_manager install_bundle target="git+https://<your-git>/<group>/dsh-d365-kit.git#v0.29.0"
```

DSH 用 pnpm 从 git 拉包。装完确认：

```
plugin_manager list_plugins
```

`include:dsh-d365-kit` 存在且 `enabled=true`、`fiberPhase=active` 即成功。

### 方式三：从本地目录安装

把整个仓库目录放到本机任意位置：

```bash
plugin_manager install_bundle target="D:\path\to\dsh-d365-kit"
```

这是 `link:` 安装：改代码立刻生效（但 Host 侧仍需重载），升级要自己 `git pull`。

### 方式四：zip

解压后按方式三装。

### 装完必须重启一次

Host 侧工具在安装时就能用；**设置页**属于 Web 客户端插件，DSH 对客户端插件的模块图有缓存，必须重启 DSH 才会把页面加载进来。

重启后打开 设置，应看到「D365 工具箱」。看不到时先跑 `d365_envs` 确认 Host 侧已加载，再看 `plugin_manager list_plugins` 里的条目名。

## 首次配置

1. 设置 → D365 工具箱 → **环境** → 添加环境：

   | 字段 | 说明 |
   | --- | --- |
   | key | 工具里用的短名，例如 `dev`、`sit`。**一旦写入计划就会记进审计，建议起稳定的名字** |
   | URL | 环境地址，例如 `https://contoso-dev.crm5.dynamics.com` |
   | 云 | `public` / `usgovernment` / `dod` / `china`，决定登录端点 |
   | 租户 ID | Entra 租户 GUID |
   | ClientId | 应用注册的 Application (client) ID |
   | 客户端密钥 | 应用注册里生成的 secret 值 |

2. 点「测试连接」，返回组织名与版本号说明凭据正确。
3. **保存**。密钥写进 `d365.secrets.json`，其余进 `d365.config.json`。
4. **权限**标签按环境分块列出能力：「读取元数据」默认开启（关掉后连表、字段、视图都查不到）；要读业务记录再勾「读取业务数据」（默认关闭）。
5. 需要写入时，勾对应能力，并填「变更默认解决方案」（一个**已存在的未受管**解决方案唯一名）。

## 配置存在哪

环境清单与工具参数存在 `configFile`：

```
<工作区>/d365.config.json      # 环境清单、默认环境、工具参数、权限
<工作区>/d365.secrets.json     # 只放 clientSecret 与 gitlabToken（明文）
```

`configFile` 的解析顺序：

1. `cordis.patch.yml` 里的 `configFile`（绝对路径，安装时的机器相关配置）
2. 环境变量 `D365_CONFIG_FILE`
3. `<USERPROFILE>\Documents\deepseek-harness\default-workspace\d365.config.json`（该目录存在时）
4. `<当前工作目录>\d365.config.json`

仓库里的 `cordis.patch.yml` 不带 `configFile`，所以默认落到第 3 条；工作区在别处时用环境变量或 patch 指定。
`d365.secrets.json` 始终与 `configFile` 同目录。

**这两个文件不要提交到 Git**：仓库的 `.gitignore` 已经挡住它们与 `.d365/`。

## 凭据解析顺序

每个值（`tenantId` / `clientId` / `clientSecret`）按顺序取：

1. 环境配置里的内联值；
2. 设置页写进 `d365.secrets.json` 的 `clientSecret`（覆盖层）；
3. 该环境配置里 `<kind>Env` 指定的环境变量名，如 `"clientSecretEnv": "D365_DEV_SECRET"`；
4. 派生名 `D365_<ENV>_<KIND>`，如 `D365_dev_CLIENT_SECRET`（key 原样，含连字符）；
5. 共享名 `D365_TENANT_ID` / `D365_CLIENT_ID` / `D365_CLIENT_SECRET`。

生产环境更建议用环境变量，本机调试用设置页即可。

令牌在进程内存里缓存，按「URL + 租户 + ClientId + 密钥」的指纹区分——换了凭据会立即重取，不用重启。

## 验证

```
d365_envs check=true
d365_metadata resource=entities top=3
```

两次都有内容就通了。第一次 `d365_sync` 会拉全量元数据（真实环境约 125 MB、三分钟），不想占盘可以跳过，用 `d365_metadata` 按需查。

## 升级

```bash
# 从 Git 安装的
plugin_manager remove_bundle target=dsh-d365-kit
plugin_manager install_bundle target="git+https://<your-git>/<group>/dsh-d365-kit.git#v0.29.0"
```

改版本号后必须**先 remove 再 install**：link/pnpm 认为包已存在时会返回 `already-installed`，不会替换代码。

升级后重启 DSH（设置页代码要重新进模块图）。

## 卸载

```bash
plugin_manager remove_bundle target=dsh-d365-kit
```

本机数据（`d365.config.json`、`d365.secrets.json`、`.d365/`）不会删，需要时手动清理。

## 多人共用

- 每个人都装一份，各自填自己的 `d365.config.json` 与密钥；
- **权限是按机器授权的**：别人机器上的勾选不影响你，反之亦然；
- 报告与快照都在各自工作区，不共享；
- 想让全组用同一套环境定义，可把 `d365.config.json` 的 `environments` 放进内部文档，但密钥仍各自填。
