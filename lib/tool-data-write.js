/**
 * Write business records — create one row, or patch fields on one row.
 *
 * Deliberately narrow: no delete, no bulk update, no upsert by filter. Every
 * call is confirmed in the conversation first, because business data is not
 * something a plan file can stage ahead of time the way metadata can.
 */
import { randomUUID } from 'node:crypto'
import { loadConfig } from './config.js'
import { D365Error } from './errors.js'
import { allows, readPolicy } from './write-policy.js'
import { makeClient, pickEnvironments, writeArtifact } from './runtime.js'
import { resolveEntitySet } from './tool-data.js'

const APPROVE = '批准执行'
const CANCEL = '取消'
const CONFIRM_ID = 'd365-data-write-confirm'

const ACTIONS = ['create', 'update']

const definition = {
  name: 'd365_data_write',
  description:
    '新建或修改表中的一条业务记录（不删除）。需要环境授权「新增/修改业务数据」（data.write）；每次写入前会在对话里弹出确认卡片。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'entity', 'values'],
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'create：新建一条；update：按 id 修改已有记录。',
      },
      entity: {
        type: 'string',
        description: '实体逻辑名（如 contoso_systemconfiguration）或集合名（如 contoso_systemconfigurations）。',
      },
      id: {
        type: 'string',
        description: 'action=update 时必填：记录的主键 GUID。',
      },
      values: {
        type: 'object',
        additionalProperties: true,
        description: '要写入的字段与值，键用字段逻辑名；值为 null 表示清空。',
      },
      environment: {
        type: 'string',
        description: '环境 key，省略则用默认环境。',
      },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string', description: '给人看的摘要。' } },
    },
    render(_args, value) {
      return [{ type: 'text', text: value.text }]
    },
  },
}

function clip(value, max = 120) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === undefined) return 'null'
  return text.length > max ? `${text.slice(0, max)}…（${text.length} 字符）` : text
}

function describeValues(values) {
  const entries = Object.entries(values ?? {})
  if (!entries.length) return '（没有字段）'
  const lines = entries.slice(0, 20).map(([key, value]) => `  ${key} = ${clip(value)}`)
  if (entries.length > 20) lines.push(`  … 其余 ${entries.length - 20} 个字段`)
  return lines.join('\n')
}

function describeConfirmation(envKey, set, action, id, values) {
  const lines = [`环境：${envKey}`, `目标：${set}`, `操作：${action === 'create' ? '新建一条记录' : `修改记录 ${id}`}`]
  lines.push('字段：')
  lines.push(describeValues(values))
  lines.push('业务数据写入不需要发布，也不会生成待确认计划；确认后立即生效。')
  return lines.join('\n')
}

function checkValues(values) {
  const entries = Object.entries(values ?? {})
  if (!entries.length) throw new D365Error('values 不能为空', { hint: '至少给一个字段，例如 {"name":"Test"}' })
  for (const [key] of entries) {
    if (key.startsWith('@')) {
      throw new D365Error(`字段 ${key} 看起来是 OData 注解，不能写入`, { code: 'invalid-field' })
    }
  }
  return entries.length
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args, exec) {
      const action = String(args.action ?? '')
      if (!ACTIONS.includes(action)) {
        throw new D365Error(`未知 action：${action}`, { hint: `可用：${ACTIONS.join(' / ')}` })
      }
      const config = await loadConfig(state.rawConfig)
      const targets = pickEnvironments(config, {
        environment: args.environment,
        environments: args.environments,
        allEnvironments: args.allEnvironments,
      })
      if (targets.length !== 1) {
        throw new D365Error('data.write 一次只能写一个环境', {
          hint: `收到 ${targets.length} 个环境：${targets.map((item) => item.key).join(', ')}；请用 environment 指定一个。`,
        })
      }
      const env = targets[0]
      const envKey = env.key

      const policy = await readPolicy(config.configFile)
      if (!allows(policy, envKey, 'data.write')) {
        throw new D365Error(`环境 ${envKey} 未授权新增或修改业务数据`, {
          code: 'data-write-forbidden',
          hint: `在设置页「权限」里给 ${envKey} 勾上「新增/修改业务数据」后再试。`,
        })
      }

      const values = args.values && typeof args.values === 'object' ? args.values : {}
      const fieldCount = checkValues(values)
      const client = makeClient(env, config)
      const resolved = await resolveEntitySet(client, args.entity, exec?.signal)
      const id = String(args.id ?? '').trim()
      if (action === 'update' && !id) {
        throw new D365Error('update 需要 id', { hint: '传记录的主键 GUID；不确定的话先用 d365_data sample 看一眼。' })
      }

      const userQuestions = ctx.get('userQuestions')
      if (!userQuestions?.ask) {
        throw new D365Error('当前会话没有可用的确认界面', {
          hint: '业务数据写入必须在对话里确认；这个工具没有「存起来稍后执行」的路径。',
        })
      }
      if (!exec?.agent) {
        throw new D365Error('需要可交互的会话', { hint: '请在主对话里调用。' })
      }

      const answer = await userQuestions.ask({
        questions: [{
          id: CONFIRM_ID,
          header: `确认写入数据 ${envKey}`,
          question: action === 'create'
            ? `要在 ${envKey} 的 ${resolved.set} 新建一条记录吗？`
            : `要修改 ${envKey} 的 ${resolved.set}（${id}）吗？`,
          detail: describeConfirmation(envKey, resolved.set, action, id, values),
          options: [
            { label: APPROVE, description: '立即写入该环境' },
            { label: CANCEL, description: '不执行，什么都不改' },
          ],
        }],
        agent: exec.agent,
        ...(exec.signal ? { signal: exec.signal } : {}),
        wait: { callId: exec.callId },
      })
      const chosen = answer?.answers?.find((item) => item.id === CONFIRM_ID)?.selected?.[0]
      if (chosen !== APPROVE) return { text: `未执行。${envKey} 的 ${resolved.set} 没有发生任何变化。` }

      let createdId
      if (action === 'create') {
        const record = await client.sendJson(resolved.set, {
          method: 'POST',
          body: values,
          headers: { Prefer: 'return=representation' },
        }, exec.signal)
        const entry = Object.entries(record ?? {})
          .find(([key, value]) => typeof value === 'string' && (key === resolved.idField || /^\w*id$/i.test(key)))
        createdId = entry?.[1]
      } else {
        await client.sendJson(`${resolved.set}(${id})`, {
          method: 'PATCH',
          body: values,
          headers: { 'If-Match': '*' },
        }, exec.signal)
      }

      const artifact = {
        kind: 'data-write',
        at: new Date().toISOString(),
        envKey,
        entitySet: resolved.set,
        action,
        id: createdId ?? (action === 'update' ? id : undefined),
        fields: Object.keys(values),
      }
      const path = await writeArtifact(config, `data-write-${randomUUID().slice(0, 8)}`, artifact)
      const target = action === 'create'
        ? `已在 ${envKey} 的 ${resolved.set} 新建 1 条记录${createdId ? `（id ${createdId}）` : ''}，${fieldCount} 个字段。`
        : `已更新 ${envKey} 的 ${resolved.set}(${id})，${fieldCount} 个字段。`
      return { text: `${target}\n\n审计记录只记字段名，不落值：${path}` }
    },
  })
}
