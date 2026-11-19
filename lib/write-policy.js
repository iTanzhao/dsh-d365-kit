/**
 * Write policy: who may change what, in which environment.
 *
 * The plugin stays read-only unless a person grants a capability here. The
 * grant lives in the same `d365.config.json` humans already edit, so it is
 * per-machine by default: the file is not shared, and a teammate's install
 * has its own policy.
 *
 * Every request consults this file: metadata reads, business-record reads and
 * every write. Metadata reads are the one capability granted by default, so an
 * install that never opened this page still behaves like a read-only tool.
 *
 * Capabilities are deliberately narrow. Every one of them maps to one official
 * Dataverse action, which keeps the blast radius of a mistake to the thing the
 * person asked for.
 */
import { readFile } from 'node:fs/promises'
import { D365Error } from './errors.js'
import { withConfigWriteLock, writeJsonFile } from './settings-store.js'
import { t } from './i18n.js'

export function localizedCapabilities() {
  return Object.fromEntries(Object.entries(CAPABILITIES).map(([key, value]) => [key, {
    ...value,
    group: t(`capability.${key}.group`),
    label: t(`capability.${key}.label`),
    description: t(`capability.${key}.description`),
  }]))
}

export const CAPABILITIES = {
  'metadata.read': {
    group: 'Metadata',
    label: 'Read metadata',
    action: 'GET',
    description:
      'Allows reading table, field, form, view, plug-in and solution-layer definitions. Enabled by default for environments not explicitly listed; disabling it also disables metadata tools.',
  },
  'optionValue.add': {
    group: 'Option sets',
    label: 'Add option values',
    action: 'InsertOptionValue',
    description: 'Append a new value to a global option set without changing existing values.',
  },
  'optionValue.updateLabel': {
    group: 'Option sets',
    label: 'Update option labels',
    action: 'UpdateOptionValue',
    description: 'Change only the display label, not the numeric value or bindings.',
  },
  'optionValue.delete': {
    group: 'Option sets',
    label: 'Delete option values',
    action: 'DeleteOptionValue',
    risk: 'high',
    description: 'Delete an option value. Deletion fails if records still use it, and its label cannot be recovered.',
  },
  'attribute.add': {
    group: 'Fields',
    label: 'Add field',
    action: 'CreateAttribute',
    description: 'Create a column on a table (string, integer, decimal, money, Boolean, or date/time).',
  },
  'attribute.update': {
    group: 'Fields',
    label: 'Update field display name',
    action: 'UpdateAttribute',
    description: 'Change a column display name, description, or required level; not type or data.',
  },
  'attribute.delete': {
    group: 'Fields',
    label: 'Delete field',
    action: 'DeleteAttribute',
    risk: 'high',
    description: 'Permanently delete the column and its data. This cannot be undone and fails when dependencies exist.',
  },
  'entity.update': {
    group: 'Tables',
    label: 'Update table display name',
    action: 'UpdateEntity',
    description: 'Change the table display name and description; not columns or data.',
  },
  'view.columns': {
    group: 'Views',
    label: 'Update view columns',
    action: 'UpdateSavedQuery',
    description: 'Add or remove system-view columns by changing layoutxml; filters and personal views are untouched.',
  },
  'layer.remove': {
    group: 'Component layers',
    label: 'Remove custom layer',
    action: 'RemoveActiveCustomizations',
    risk: 'high',
    description:
      'Remove the top unmanaged Active custom layer so the managed layer below takes effect. Irreversible. Supports tables, fields, global option sets, forms, views, flows, Web resources, plug-in assemblies/types/steps, and custom APIs.',
  },
  'role.admin': {
    group: 'Security roles',
    label: 'Change security roles',
    action: 'Associate / AddPrivilegesRole',
    risk: 'high',
    description:
      'Assign or remove roles for users/teams and change role privileges (column-level and four scope depths). This is permission-changing access control and can expose data accidentally. Disabled by default; every execution requires confirmation.',
  },
  'message.invoke': {
    group: 'Messages',
    label: 'Invoke messages',
    action: 'Custom Action / Function',
    risk: 'high',
    description:
      'Invoke custom actions or functions such as WinOpportunity or contoso_DoSomething. Their plug-in-defined behavior may write data or send notifications. Disabled by default; every call shows the request and requires confirmation.',
  },
  'data.read': {
    group: 'Data',
    label: 'Read business data',
    action: 'GET',
    description:
      'Read business records (customers, orders, configuration), not only metadata. Disabled by default; when off, non-metadata tables cannot be read.',
  },
  'data.write': {
    group: 'Data',
    label: 'Create/update business data',
    action: 'POST/PATCH',
    risk: 'high',
    description:
      'Create or update business records. Deletes are excluded. Disabled by default; every write requires confirmation.',
  },
}

export const CAPABILITY_KEYS = Object.keys(CAPABILITIES)

/** Read the raw config file; `write` is not part of the normalized config. */
async function readRaw(configPath) {
  try {
    const text = (await readFile(configPath, 'utf8')).replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Read the raw config for a rewrite.
 *
 * Unlike `readRaw`, an unreadable file is an error here: treating it as `{}` and
 * writing the policy back would erase every environment the settings page saved.
 * A missing file is still fine — that is a first-time save.
 */
async function readRawForWrite(configPath) {
  let text
  try {
    text = (await readFile(configPath, 'utf8')).replace(/^\uFEFF/, '')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new D365Error(t('writePolicy.configUnreadable', { path: configPath }), {
      code: 'config-unreadable',
      hint: t('writePolicy.configUnreadableHint'),
    })
  }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new D365Error(t('writePolicy.configInvalid', { path: configPath }), {
      code: 'config-invalid',
      hint: t('writePolicy.configInvalidHint'),
    })
  }
}

/**
 * Bumped when the meaning of an entry changes. Version 2 added `metadata.read`:
 * files written before it list only the old capabilities, so those entries get
 * the (previously implicit) metadata read added back rather than losing it.
 */
const POLICY_VERSION = 2

/**
 * @returns `{ environments: { [envKey]: capability[] }, solutionHint }` —
 *   an environment missing here has never been configured and keeps the
 *   default metadata read; an empty array means every capability is revoked.
 */
export async function readPolicy(configPath) {
  if (!configPath) return { environments: {} }
  const raw = await readRaw(configPath)
  const version = Number(raw.write?.capabilityVersion ?? 1)
  const environments = {}
  for (const [key, value] of Object.entries(raw.write?.environments ?? {})) {
    if (!Array.isArray(value)) continue
    // An empty list is meaningful: it is how a page "revokes everything" for an
    // environment, including the default-on metadata read. Dropping it here
    // would silently turn the default back on.
    const allowed = value.filter((item) => CAPABILITY_KEYS.includes(item))
    if (version < POLICY_VERSION && !allowed.includes('metadata.read')) allowed.push('metadata.read')
    environments[key] = allowed
  }
  return {
    environments,
    solutionHint: raw.write?.solutionUniqueName ?? undefined,
  }
}

/**
 * Replace the policy section, leaving the rest of the config untouched.
 *
 * The config file is shared with the settings page: the write runs under the
 * same queue so a policy save cannot overwrite an environment save that
 * happened between our read and our write. The file is replaced through a temp
 * name so a crash cannot leave a truncated config (which would drop every
 * environment on the next load).
 */
export async function savePolicy(configPath, policy) {
  return withConfigWriteLock(async () => {
    const raw = await readRawForWrite(configPath)
    const environments = {}
    for (const [key, value] of Object.entries(policy?.environments ?? {})) {
      // Keep an explicit empty list: absence means "not configured yet" (metadata
      // read on), an empty list means "everything off".
      environments[key] = Array.isArray(value) ? value.filter((item) => CAPABILITY_KEYS.includes(item)) : []
    }

    const write = { ...(raw.write ?? {}), environments, capabilityVersion: POLICY_VERSION }
    if (policy?.solutionUniqueName) write.solutionUniqueName = String(policy.solutionUniqueName).trim()
    else delete write.solutionUniqueName

    if (!Object.keys(environments).length && !write.solutionUniqueName) delete raw.write
    else raw.write = write

    await writeJsonFile(configPath, raw)
    return readPolicy(configPath)
  })
}

/** Capabilities granted to an environment that has no entry yet. */
export const DEFAULT_GRANTED = ['metadata.read']

/**
 * Whether `envKey` may run `capability`.
 *
 * An environment with no entry has never been configured, so it keeps the
 * metadata default. Once an entry exists it is the whole truth — an empty
 * array turns even that default off.
 */
export function allows(policy, envKey, capability) {
  const granted = policy?.environments?.[envKey]
  if (Array.isArray(granted)) return granted.includes(capability)
  return DEFAULT_GRANTED.includes(capability)
}

/** Human-readable matrix for the tool and the page. */
export function describePolicy(policy, environmentKeys) {
  const rows = environmentKeys.map((key) => ({
    environment: key,
    capabilities: CAPABILITY_KEYS.filter((capability) => allows(policy, key, capability)),
  }))
  return { capabilities: localizedCapabilities(), rows }
}
