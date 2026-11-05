# 安装（给同事）

**[English](INSTALL.md)** | 简体中文

`dsh-d365-kit` 是 DeepSeek Harness 的 bundle（Host 插件 + 设置页）。装完会有 16 个 `d365_*` 工具和「设置 → D365 工具箱」页面。

更完整的步骤见 [docs/installation.md](docs/zh/installation.md)。

## 前置

- DSH 桌面版，能打开 Web GUI；
- 机器能访问你的 Dataverse 环境（`*.dynamics.com` 或对应区域域名）；
- 一个**应用用户**（ClientId + 密钥），在环境里给了读元数据、读解决方案（`prvReadSolution`）、
  读层表（`prvReadmsdyn_componentlayer`）的权限。只读就够用；要写入再加相应权限。

## 安装

### 方式一：从 npm 装（最短，可升级）

```
plugin_manager install_bundle target="dsh-d365-kit@0.24.1"
```

前提是包已经发到 pnpm 用的那个 registry——公网 npm 或公司内网镜像都行。包名没有 scope，不需要配 scope 映射。

> 只推 GitHub 不等于进了 registry：只有 GitHub 仓库时用方式二（或 `npm install github:<user>/<repo>#<tag>`）。配好 `NPM_TOKEN` secret 后推 `v*` tag 会自动发布（`.github/workflows/publish.yml`）。

### 方式二：从 Git 装（不需要 registry）

```
plugin_manager install_bundle target="git+https://<你的 Git>/<group>/dsh-d365-kit.git#v0.24.1"
```

### 方式三：从本地目录装

把整个仓库目录放到本机任意位置：

```
plugin_manager install_bundle target="D:\path\to\dsh-d365-kit"
```

这是 `link:` 安装：改代码立刻生效，但升级要自己 `git pull`。

三条路一样：**装完重启一次 DSH**，Web 客户端才会把设置页代码加载进模块图。

## 首次配置

1. 设置 → D365 工具箱 → 环境 → 添加环境：key（如 `dev`）、URL、租户 ID、ClientId、客户端密钥；
2. 点「测试连接」，看到版本号说明凭据没问题；
3. 到「权限」标签勾选这台机器允许做什么：
   - 「读取业务数据」——不勾就只能读元数据，读不到表里的记录；
   - 写入类能力默认全关，勾了之后每次执行仍要人在对话里确认；
4. 点「保存」。

配置默认写到 `<你的 DSH 工作区>/d365.config.json`，密钥单独存同目录的 `d365.secrets.json`
（明文，别提交）。工作区不在默认位置时，设环境变量 `D365_CONFIG_FILE`，或在 profile 的
`cordis.patch.yml` 里给 `configFile` 写绝对路径。

## 验证

```
d365_envs check=true
d365_metadata resource=entities top=3
```

都有内容就说明通了。第一次 `d365_sync` 会拉全量元数据（约 125 MB、三分钟左右），不想占盘可以先不做。

## 升级

```
plugin_manager remove_bundle target=dsh-d365-kit
plugin_manager install_bundle target="...新版本..."
```

必须先 remove 再 install：包已存在时安装器只返回 `already-installed`，不会替换代码。升级后重启 DSH。

## 常见问题

- **工具没出现**：`plugin_manager list_plugins` 看 `include:dsh-d365-kit` 是否 `active`；刚装完要重启。
- **设置页没有「D365 工具箱」**：客户端插件未进模块图，重启；仍没有就查 `client.js` 的模块 id 是否与包名一致。
- **保存报「写入只能从设置页发起」**：CSRF 守卫，只在设置页里保存；被拒记录在 `.d365/write-guard.log`。
- **读业务数据报 `data-read-forbidden`**：到权限标签勾「读取业务数据」。
- **写入被拒 `environment-busy`**：环境正在导入或发布，等结束再试。
- **GitLab 403**：令牌用户在该项目里至少要有 Reporter 角色。

其余错误码见 [docs/troubleshooting.md](docs/zh/troubleshooting.md)。
