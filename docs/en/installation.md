# Installation & Configuration

**English** | [简体中文](../zh/installation.md)

## Prerequisites

| Item | Requirement |
| --- | --- |
| DSH | Desktop edition, able to open the Web GUI (the settings page is a Web client plugin) |
| Network | Able to reach the environment domain (`*.crm*.dynamics.com` or the matching region) and the sign-in endpoint |
| Application user | An app registration in Entra ID plus an application user created in Dataverse, giving you `ClientId` / `ClientSecret` / `TenantId` |
| Permissions | Read metadata, read solutions (`prvReadSolution`), read custom APIs (`prvReadCustomAPI`), read the layer table (`prvReadmsdyn_componentlayer`) |

A read-only application user is enough; for the write capabilities, messages such as `CreateAttribute` require the matching permission on that user in the environment (system customizer, or the matching privileges ticked in a custom role).

> Once the application user is created in one environment, create it again in **every** target environment (the same ClientId can be reused).

## Installation

### Option 1: install from npm (shortest)

```bash
plugin_manager install_bundle target="dsh-d365-kit@0.26.0"
```

Works once the package is published to the registry pnpm is configured against — public npm or an internal mirror. The package has no scope, so no scope mapping is needed. To install a specific version pin it as `dsh-d365-kit@<version>`.

> **GitHub alone is not a registry.** A repository on GitHub is reachable directly through the `git+https://...` spec (option 2), and plain `npm install` can also take `github:<user>/<repo>#<tag>`; but `install_bundle target="dsh-d365-kit"` only resolves after the package is published to a registry. The repo ships `.github/workflows/publish.yml`: configure the `NPM_TOKEN` secret, push a `v*` tag, and the package is published for you.

### Option 2: install from Git (no registry needed)

```bash
plugin_manager install_bundle target="git+https://<your-git>/<group>/dsh-d365-kit.git#v0.26.0"
```

DSH pulls the package from git with pnpm. After installing, check:

```
plugin_manager list_plugins
```

Success means `include:dsh-d365-kit` is present with `enabled=true` and `fiberPhase=active`.

### Option 3: install from a local directory

Put the whole repository directory anywhere on this machine:

```bash
plugin_manager install_bundle target="D:\path\to\dsh-d365-kit"
```

This is a `link:` install: code changes take effect immediately (the Host side still needs a reload), and upgrading means running `git pull` yourself.

### Option 4: zip

Unzip it, then install it as in option 3.

### A restart is required after installing

Host-side tools work as soon as the plugin is installed; the **settings page** belongs to the Web client plugin, and DSH caches the client plugin module graph, so DSH must be restarted before the page is loaded.

After restarting, open Settings and you should see "D365 Toolkit". If it is missing, run `d365_envs` first to confirm the Host side has loaded, then check the entry name in `plugin_manager list_plugins`.

## First-time configuration

1. Settings → D365 Toolkit → **Environments** → Add environment:

   | Field | Description |
   | --- | --- |
   | key | Short name the tools use, e.g. `dev`, `sit`. **Once it goes into a plan it is recorded in the audit log, so pick a stable name** |
   | URL | Environment URL, e.g. `https://contoso-dev.crm5.dynamics.com` |
   | Cloud | `public` / `usgovernment` / `dod` / `china`; determines the sign-in endpoint |
   | Tenant ID | Entra tenant GUID |
   | ClientId | Application (client) ID of the app registration |
   | Client secret | Secret value generated in the app registration |

2. Click "Test connection"; an organization name and version number coming back means the credentials are correct.
3. **Save**. The secret goes into `d365.secrets.json`, everything else into `d365.config.json`.
4. The **Permissions** tab lists capabilities per environment: "Read metadata" is on by default (turn it off and tables, fields and views become unreadable); tick "Read business data" to read records (off by default).
5. To write, tick the matching capabilities and fill in "Default solution for changes" (the unique name of an **existing unmanaged** solution).

## Where the configuration lives

The environment list and tool parameters live in `configFile`:

```
<workspace>/d365.config.json      # environment list, default environment, tool parameters, permissions
<workspace>/d365.secrets.json     # holds only clientSecret and gitlabToken (plaintext)
```

`configFile` is resolved in this order:

1. `configFile` in `cordis.patch.yml` (an absolute path, machine-specific configuration from install time)
2. The `D365_CONFIG_FILE` environment variable
3. `<USERPROFILE>\Documents\deepseek-harness\default-workspace\d365.config.json` (when that directory exists)
4. `<current working directory>\d365.config.json`

The repository's `cordis.patch.yml` carries no `configFile`, so the default falls through to item 3; when the workspace is elsewhere, set it with the environment variable or the patch.
`d365.secrets.json` always sits in the same directory as `configFile`.

**Do not commit these two files to Git**: the repository's `.gitignore` already covers them and `.d365/`.

## Credential resolution order

Each value (`tenantId` / `clientId` / `clientSecret`) is taken in this order:

1. The inline value in the environment configuration;
2. The `clientSecret` the settings page writes into `d365.secrets.json` (an overlay);
3. The environment variable name given by `<kind>Env` in that environment's configuration, e.g. `"clientSecretEnv": "D365_DEV_SECRET"`;
4. The derived name `D365_<ENV>_<KIND>`, e.g. `D365_dev_CLIENT_SECRET` (the key as-is, hyphens included);
5. The shared names `D365_TENANT_ID` / `D365_CLIENT_ID` / `D365_CLIENT_SECRET`.

Production is better served by environment variables; the settings page is enough for local debugging.

Tokens are cached in process memory and keyed by a fingerprint of "URL + tenant + ClientId + secret" — changed credentials are fetched immediately, with no restart.

## Verification

```
d365_envs check=true
d365_metadata resource=entities top=3
```

If both return content, it works. The first `d365_sync` pulls the full metadata (about 125 MB, three minutes on a real environment); if you would rather not use the disk, skip it and query on demand with `d365_metadata`.

## Upgrade

```bash
# installed from Git
plugin_manager remove_bundle target=dsh-d365-kit
plugin_manager install_bundle target="git+https://<your-git>/<group>/dsh-d365-kit.git#v0.26.0"
```

After changing the version number you must **remove first, then install**: link/pnpm returns `already-installed` when it believes the package exists, and does not replace the code.

Restart DSH after upgrading (the settings page code has to re-enter the module graph).

## Uninstall

```bash
plugin_manager remove_bundle target=dsh-d365-kit
```

Local data (`d365.config.json`, `d365.secrets.json`, `.d365/`) is not deleted; clean it up manually when needed.

## Sharing with a team

- Everyone installs a copy and fills in their own `d365.config.json` and secrets;
- **Permissions are granted per machine**: ticks on someone else's machine do not affect yours, and vice versa;
- Reports and snapshots live in each person's workspace and are not shared;
- To give the whole team the same environment definitions, put the `environments` from `d365.config.json` into an internal document — each person still fills in their own secrets.
