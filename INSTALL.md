# Install (for colleagues)

**English** | [简体中文](INSTALL.zh-CN.md)

`dsh-d365-kit` is a DeepSeek Harness bundle (host plugin + settings page). Once installed you get 15 `d365_*` tools and a "Settings → D365 Toolkit" page.

For the complete steps, see [docs/en/installation.md](docs/en/installation.md).

## Prerequisites

- DSH desktop app, able to open the Web GUI;
- the machine can reach your Dataverse environment (`*.dynamics.com` or the regional domain);
- an **application user** (ClientId + secret) granted permission in the environment to read metadata,
  read solutions (`prvReadSolution`) and read the layer table (`prvReadmsdyn_componentlayer`). Read-only is
  enough; add the relevant permissions when you need writes.

## Install

### Option 1: Install from npm (shortest, upgradeable)

```
plugin_manager install_bundle target="dsh-d365-kit@0.24.1"
```

This needs the package to be published to the registry pnpm uses — public npm or an internal mirror. The name has no scope, so no scope mapping is required.

> Publishing to GitHub does not put the package in a registry: with only a GitHub repo, use option 2 (or `npm install github:<user>/<repo>#<tag>`). Pushing a `v*` tag publishes automatically once the `NPM_TOKEN` secret exists (`.github/workflows/publish.yml`).

### Option 2: Install from Git (no registry needed)

```
plugin_manager install_bundle target="git+https://<your Git>/<group>/dsh-d365-kit.git#v0.24.1"
```

### Option 3: Install from a local directory

Put the whole repository directory anywhere on the machine:

```
plugin_manager install_bundle target="D:\path\to\dsh-d365-kit"
```

This is a `link:` install: code changes take effect immediately, but upgrading is your own `git pull`.

All paths are the same: **restart DSH once after installing**, so the Web client loads the settings page code into the module graph.

## First-time configuration

1. Settings → D365 Toolkit → Environments → Add environment: key (e.g. `dev`), URL, tenant ID, ClientId, client secret;
2. Click "Test connection"; if you see a version number, the credentials are fine;
3. On the "Permissions" tab, tick what this machine is allowed to do:
   - "Read business data" — without it only metadata is readable, not the records in tables;
   - write capabilities are all off by default, and even when ticked every execution still needs a person to confirm it in the conversation;
4. Click "Save".

By default the configuration is written to `<your DSH workspace>/d365.config.json`, and the secret is stored separately in `d365.secrets.json` in the same directory
(plain text, don't commit it). If your workspace isn't in the default location, set the `D365_CONFIG_FILE` environment variable, or point `configFile` at an absolute path in the profile's
`cordis.patch.yml`.

## Verify

```
d365_envs check=true
d365_metadata resource=entities top=3
```

If both return content, you're connected. The first `d365_sync` pulls the full metadata (about 125 MB, three minutes or so); if you don't want to spend the disk space, you can skip it for now.

## Upgrade

```
plugin_manager remove_bundle target=dsh-d365-kit
plugin_manager install_bundle target="...<new version>..."
```

You must remove before installing: when the package already exists the installer only returns `already-installed` and does not replace the code. Restart DSH after upgrading.

## FAQ

- **Tools don't appear**: run `plugin_manager list_plugins` and check whether `include:dsh-d365-kit` is `active`; a fresh install needs a restart.
- **No "D365 Toolkit" on the settings page**: the client plugin didn't make it into the module graph — restart; if it's still missing, check whether the module id in `client.js` matches the package name.
- **Save reports "writes can only be started from the settings page"**: that's the CSRF guard — only save from the settings page; rejections are logged to `.d365/write-guard.log`.
- **Reading business data reports `data-read-forbidden`**: tick "Read business data" on the Permissions tab.
- **A write is rejected with `environment-busy`**: the environment is importing or publishing; wait for it to finish and retry.
- **GitLab 403**: the token's user needs at least the Reporter role in that project.

For other error codes, see [docs/en/troubleshooting.md](docs/en/troubleshooting.md).
