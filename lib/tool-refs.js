/**
 * `d365_refs` — the reverse question: who uses this?
 *
 * `d365_metadata` answers "does it exist"; `d365_layers` answers "who overrides
 * it"; this answers "what breaks if I remove or rename it". Every branch reads
 * stored definitions (formxml, layoutxml/fetchxml, workflow clientdata) and
 * reports exact matches, so the answer is evidence rather than a guess.
 */
import { loadConfig } from './config.js'
import { makeClient, pickEnvironments, writeArtifact } from './runtime.js'
import { D365Error } from './errors.js'
import {
  findFieldAutomations,
  findFieldForms,
  findFieldViews,
  findPluginUsage,
  findResourceForms,
} from './refs.js'

const KINDS = ['field', 'web_resource', 'plugin_assembly']

export const definition = {
  name: 'd365_refs',
  description:
    '反查引用：某个字段被哪些表单/视图/流程使用，某个 Web 资源被哪些表单加载，某个插件程序集有哪些注册类型与步骤。'
    + '用于判断"改这个/删这个会不会坏"，与 d365_layers（谁覆盖）互补。可一次查多个环境。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['kind'],
    properties: {
      kind: {
        type: 'string',
        enum: KINDS,
        description: 'field：字段引用；web_resource：表单脚本引用；plugin_assembly：插件注册情况。',
      },
      entity: {
        type: 'string',
        description: 'kind=field 时必填：字段所属实体逻辑名，例如 account。',
      },
      attribute: {
        type: 'string',
        description: 'kind=field 时必填：字段逻辑名，例如 contoso_customertier。',
      },
      name: {
        type: 'string',
        description: 'kind=web_resource 时填 Web 资源名称（如 contoso_/scripts/account_form.js）；kind=plugin_assembly 时填程序集名（如 Contoso.Customizations）。',
      },
      environment: {
        type: 'string',
        description: '环境 key，例如 dev。省略则用默认环境。',
      },
      environments: {
        type: 'array',
        items: { type: 'string' },
        description: '一次查多个环境，例如 ["dev","sit"]。',
      },
      allEnvironments: {
        type: 'boolean',
        description: '对全部已配置环境执行同一查询。',
      },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string' },
      },
    },
    render(_args, value) {
      return [{ type: 'text', text: value?.text ?? '' }]
    },
  },
}

/** Render a field reference report for one environment. */
function renderField(env, entity, attribute, result) {
  const lines = [`字段 ${entity}.${attribute} 的引用（${env.key}）`]
  const total = result.forms.length + result.views.length + result.automations.length

  lines.push('', `表单：${result.forms.length} 张`)
  for (const form of result.forms.slice(0, 10)) {
    lines.push(`- ${form.name}（${form.typeLabel}${form.managed ? '，受管' : ''}${form.visible ? '' : '，字段被隐藏'}）`)
  }
  if (result.forms.length > 10) lines.push(`- … 其余 ${result.forms.length - 10} 张见文件`)

  const layout = result.views.filter((view) => view.inLayout).length
  const filtered = result.views.filter((view) => view.inFilter).length
  lines.push('', `视图：${result.views.length} 个（列 ${layout} / 筛选条件 ${filtered}）`)
  for (const view of result.views.slice(0, 10)) {
    const usage = [view.inLayout ? '显示列' : null, view.inFilter ? '筛选条件' : null].filter(Boolean).join('+')
    lines.push(`- ${view.name}（${usage}${view.default ? '，默认视图' : ''}）`)
  }
  if (result.views.length > 10) lines.push(`- … 其余 ${result.views.length - 10} 个见文件`)

  lines.push('', `流程/业务规则：${result.automations.length} 个`)
  for (const item of result.automations.slice(0, 10)) {
    lines.push(`- ${item.name}（${item.category}，${item.state}）`)
  }
  if (result.automations.length > 10) lines.push(`- … 其余 ${result.automations.length - 10} 个见文件`)

  lines.push(
    '',
    total
      ? `结论：共 ${total} 处引用；删除或改名会同时影响上述位置。`
      : '结论：没有找到引用。注意本工具按实体过滤表单，快速查看表单里引用其它实体字段的情况不在范围内。',
  )
  return lines.join('\n')
}

/** Render a web resource report for one environment. */
function renderResource(env, name, forms) {
  const lines = [`Web 资源 ${name} 的引用（${env.key}）`]
  if (!forms.length) {
    lines.push('', '结论：没有表单引用这个库。若它是 ribbon 命令或独立加载的脚本，这不代表它没在用。')
    return lines.join('\n')
  }
  lines.push('', `表单：${forms.length} 张`)
  let handlers = 0
  for (const form of forms.slice(0, 12)) {
    handlers += form.handlers.length
    const names = form.handlers.map((h) => `${h.event || '?'}→${h.functionName || '?'}`).join('，')
    lines.push(`- ${form.name}（${form.typeLabel}，${form.entity}）${names ? `：${names}` : ''}`)
  }
  if (forms.length > 12) lines.push(`- … 其余 ${forms.length - 12} 张见文件`)
  lines.push('', `结论：${forms.length} 张表单加载该库，共 ${handlers} 个事件处理器；改函数名或删文件会让这些处理器失效。`)
  return lines.join('\n')
}

/** Render a plugin assembly report for one environment. */
function renderAssembly(env, name, result) {
  const { assembly, types } = result
  const lines = [
    `插件程序集 ${assembly.name} 的注册情况（${env.key}）`,
    `版本：${assembly.version ?? '未知'}，隔离模式：${assembly.isolation ?? '?'}`,
    `类型：${types.length} 个`,
  ]
  let stepCount = 0
  let disabled = 0
  for (const type of types.slice(0, 12)) {
    stepCount += type.steps.length
    disabled += type.steps.filter((step) => !step.enabled).length
    lines.push('', `- ${type.typename}`)
    if (!type.steps.length) lines.push('  （没有注册步骤）')
    for (const step of type.steps.slice(0, 8)) {
      const filter = step.filteringAttributes ? `，过滤 ${step.filteringAttributes}` : ''
      lines.push(`  · ${step.name}（stage ${step.stage}，mode ${step.mode}，rank ${step.rank ?? 1}${filter}${step.enabled ? '' : '，已停用'}）`)
    }
    if (type.steps.length > 8) lines.push(`  · … 其余 ${type.steps.length - 8} 步见文件`)
  }
  if (types.length > 12) lines.push(`… 其余 ${types.length - 12} 个类型见文件`)
  lines.push('', `结论：共 ${stepCount} 个步骤${disabled ? `，其中 ${disabled} 个已停用` : ''}。`)
  return lines.join('\n')
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args, exec) {
      const config = await loadConfig(state.rawConfig)
      const kind = args.kind
      if (!KINDS.includes(kind)) {
        throw new D365Error(`不认识的查询类型：${kind}`, { code: 'unknown-kind', hint: `可选：${KINDS.join(' / ')}` })
      }
      if (kind === 'field' && (!args.entity || !args.attribute)) {
        throw new D365Error('kind=field 需要 entity 和 attribute', { code: 'missing-field' })
      }
      if (kind !== 'field' && !args.name) {
        throw new D365Error(`kind=${kind} 需要 name`, { code: 'missing-name' })
      }

      const envs = pickEnvironments(config, args)
      const sections = []
      const artifact = { kind, entity: args.entity, attribute: args.attribute, name: args.name, environments: {} }

      for (const env of envs) {
        const client = makeClient(env, config)
        let text
        if (kind === 'field') {
          const result = {
            forms: await findFieldForms(client, args.entity, args.attribute, exec?.signal),
            views: await findFieldViews(client, args.entity, args.attribute, exec?.signal),
            automations: await findFieldAutomations(client, args.entity, args.attribute, exec?.signal),
          }
          artifact.environments[env.key] = result
          text = renderField(env, args.entity, args.attribute, result)
        } else if (kind === 'web_resource') {
          const forms = await findResourceForms(client, args.name, exec?.signal)
          artifact.environments[env.key] = { forms }
          text = renderResource(env, args.name, forms)
        } else {
          const result = await findPluginUsage(client, args.name, exec?.signal)
          artifact.environments[env.key] = result
          text = renderAssembly(env, args.name, result)
        }
        sections.push(text)
      }

      const file = await writeArtifact(config, `refs-${kind}`, artifact)
      return { text: `${sections.join('\n\n')}\n\n完整结果：${file}` }
    },
  })
}
