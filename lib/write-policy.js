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
import { readFile, writeFile } from 'node:fs/promises'

export const CAPABILITIES = {
  'metadata.read': {
    group: '元数据',
    label: '读取元数据',
    action: 'GET',
    description:
      '允许读取表、字段、表单、视图、插件、解决方案层等元数据定义。未在配置里显式列出的环境默认开启；关掉后连元数据工具也不可用。',
  },
  'optionValue.add': {
    group: '选项集',
    label: '新增选项值',
    action: 'InsertOptionValue',
    description: '向全局选项集追加新选项（不修改已有值）。',
  },
  'optionValue.updateLabel': {
    group: '选项集',
    label: '修改选项标签',
    action: 'UpdateOptionValue',
    description: '只改选项的显示标签，不改值、不改绑定关系。',
  },
  'optionValue.delete': {
    group: '选项集',
    label: '删除选项值',
    action: 'DeleteOptionValue',
    risk: 'high',
    description: '从选项集删除一个值；已有记录若正在使用该值，删除会失败，标签也无法找回。',
  },
  'attribute.add': {
    group: '字段',
    label: '新增字段',
    action: 'CreateAttribute',
    description: '在指定表上新建列（文本、整数、小数、货币、布尔、日期时间）。',
  },
  'attribute.update': {
    group: '字段',
    label: '修改字段显示名',
    action: 'UpdateAttribute',
    description: '改列的显示名、描述、必填级别；不改类型、不改数据。',
  },
  'attribute.delete': {
    group: '字段',
    label: '删除字段',
    action: 'DeleteAttribute',
    risk: 'high',
    description: '永久删除列及其数据，不可恢复；有依赖（视图、表单、流程）时会失败。',
  },
  'entity.update': {
    group: '表',
    label: '修改表显示名',
    action: 'UpdateEntity',
    description: '改表的显示名与描述；不改列、不改数据。',
  },
  'view.columns': {
    group: '视图',
    label: '修改视图列',
    action: 'UpdateSavedQuery',
    description: '在系统视图里增删列（直接改 layoutxml）；不动筛选条件，也不动个人视图。',
  },
  'layer.remove': {
    group: '组件层',
    label: '移除自定义层',
    action: 'RemoveActiveCustomizations',
    risk: 'high',
    description:
      '删掉组件最上面的未受管自定义层（解决方案层里显示为 Active 的那一层），让下面的受管层重新生效。不可恢复；支持表、字段、全局选项集、表单、视图、流程、Web 资源、插件程序集/类型/步骤、自定义 API。',
  },
  'message.invoke': {
    group: '消息',
    label: '调用消息',
    action: 'Custom Action / Function',
    risk: 'high',
    description:
      '允许调用表外的自定义消息（action 或 function，例如 WinOpportunity、contoso_DoSomething）。消息的行为由插件决定，可能写数据、发通知；每次调用前都会在对话里弹出确认卡片并显示请求体。默认关闭。',
  },
  'data.read': {
    group: '数据',
    label: '读取业务数据',
    action: 'GET',
    description:
      '允许读取表中的业务记录（客户、订单、配置数据等），而不只是元数据定义。默认关闭；关闭时任何非元数据表都读不到。',
  },
  'data.write': {
    group: '数据',
    label: '新增/修改业务数据',
    action: 'POST/PATCH',
    risk: 'high',
    description:
      '允许新建或修改表中的业务记录（例如补一条配置数据）。不含删除；每次写入前都会在对话里弹出确认卡片。默认关闭。',
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

/** Replace the policy section, leaving the rest of the config untouched. */
export async function savePolicy(configPath, policy) {
  const raw = await readRaw(configPath)
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

  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  return readPolicy(configPath)
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
  return { capabilities: CAPABILITIES, rows }
}
