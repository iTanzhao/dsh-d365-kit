/**
 * Write policy: who may change what, in which environment.
 *
 * The plugin stays read-only unless a person grants a capability here. The
 * grant lives in the same `d365.config.json` humans already edit, so it is
 * per-machine by default: the file is not shared, and a teammate's install
 * has its own policy.
 *
 * Capabilities are deliberately narrow. Every one of them maps to one official
 * Dataverse action, which keeps the blast radius of a mistake to the thing the
 * person asked for.
 */
import { readFile, writeFile } from 'node:fs/promises'

export const CAPABILITIES = {
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
 * @returns `{ environments: { [envKey]: capability[] } }` — an environment
 *   missing here has no write permission at all.
 */
export async function readPolicy(configPath) {
  if (!configPath) return { environments: {} }
  const raw = await readRaw(configPath)
  const environments = {}
  for (const [key, value] of Object.entries(raw.write?.environments ?? {})) {
    if (!Array.isArray(value)) continue
    const allowed = value.filter((item) => CAPABILITY_KEYS.includes(item))
    if (allowed.length) environments[key] = allowed
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
    const allowed = Array.isArray(value) ? value.filter((item) => CAPABILITY_KEYS.includes(item)) : []
    if (allowed.length) environments[key] = allowed
  }

  const write = { ...(raw.write ?? {}), environments }
  if (policy?.solutionUniqueName) write.solutionUniqueName = String(policy.solutionUniqueName).trim()
  else delete write.solutionUniqueName

  if (!Object.keys(environments).length && !write.solutionUniqueName) delete raw.write
  else raw.write = write

  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  return readPolicy(configPath)
}

/** Whether `envKey` may run `capability`. */
export function allows(policy, envKey, capability) {
  return Boolean(policy?.environments?.[envKey]?.includes(capability))
}

/** Human-readable matrix for the tool and the page. */
export function describePolicy(policy, environmentKeys) {
  const rows = environmentKeys.map((key) => ({
    environment: key,
    capabilities: CAPABILITY_KEYS.filter((capability) => allows(policy, key, capability)),
  }))
  return { capabilities: CAPABILITIES, rows }
}
