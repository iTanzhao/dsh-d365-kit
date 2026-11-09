/**
 * `d365_invoke` — call a Dataverse action or function once, and show what came
 * back.
 *
 * This is the tool that turns "the POST failed with some 400" into something a
 * person can look at: an action such as `WinOpportunity` behaves exactly like
 * a plugin step, so reproducing a failure means sending the same message with
 * the same parameters. Nothing here is a batch API: one message, one call, one
 * confirmation.
 *
 * It is deliberately narrow:
 * - the environment must grant `message.invoke` (off by default, high risk);
 * - every call asks in the chat first and prints the exact path and body;
 * - a failed call returns the HTTP status, the Dataverse error code and the
 *   response body instead of throwing them away — that body is usually the only
 *   place the failing field or plugin trace GUID appears.
 */
import { loadConfig } from './config.js'
import { makeClient, pickEnvironments, writeArtifact } from './runtime.js'
import { D365Error } from './errors.js'
import { allows, readPolicy } from './write-policy.js'
import { odataString } from './resources.js'

const CONFIRM_ID = 'd365-invoke-confirm'
const APPROVE = '调用'
const CANCEL = '取消'
const ALLOWED_METHODS = ['POST', 'GET']

/** Format one function parameter as an OData literal. */function odataLiteral(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map((item) => odataLiteral(item)).join(',')}]`
  if (typeof value === 'object') return JSON.stringify(value)
  return `'${odataString(String(value))}'`
}

/**
 * Build the request path plus query for one message.
 *
 * Bound actions hang off the record (`accounts(<id>)/Microsoft.Dynamics.CRM.X`);
 * unbound ones are a bare segment. A GET function carries its parameters as
 * aliases (`Name(x=@p0)?@p0=...`), which is the only form Dataverse accepts.
 */
export function buildInvokeRequest({ message, method, entity, id, parameters }) {
  const name = String(message ?? '').trim()
  if (!name) throw new D365Error('message 不能为空', { code: 'missing-message', hint: '例如 WinOpportunity 或 contoso_DoSomething。' })
  const verb = String(method ?? 'POST').toUpperCase()
  if (!ALLOWED_METHODS.includes(verb)) {
    throw new D365Error(`不支持的方法：${method}`, { code: 'bad-method', hint: '只支持 POST（action）与 GET（function）。' })
  }
  if (verb === 'GET' && (entity || id)) {
    throw new D365Error('GET function 不支持绑定到记录', {
      code: 'bad-binding',
      hint: '带 entity + id 的调用是绑定 action，只能 POST。',
    })
  }

  const base = entity
    ? `${String(entity).trim()}(${String(id ?? '').trim()})/Microsoft.Dynamics.CRM.${name}`
    : name

  if (verb === 'POST') {
    const body = parameters && typeof parameters === 'object' && !Array.isArray(parameters) ? parameters : {}
    return { path: base, query: {}, body }
  }

  const entries = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
    ? Object.entries(parameters)
    : []
  const query = {}
  const args = entries.map(([key, value], index) => {
    const alias = `@p${index}`
    query[alias] = odataLiteral(value)
    return `${key}=${alias}`
  })
  return { path: `${base}(${args.join(',')})`, query, body: undefined }
}

/** Human-readable one-liner for the confirmation card. */
export function describeInvoke(envKey, message, method, path, body) {
  const verb = String(method ?? 'POST').toUpperCase()
  const lines = [
    `环境：${envKey}`,
    `消息：${message}（${verb}）`,
    `路径：/${path}`,
  ]
  if (body !== undefined) {
    const text = JSON.stringify(body, null, 2)
    lines.push('请求体：', text.length > 1200 ? `${text.slice(0, 1200)}…` : text)
  }
  lines.push(
    '',
    '这条消息由目标环境的插件实现，可能写数据、发通知或调用外部系统；工具不猜测它做了什么。',
  )
  return lines.join('\n')
}

function truncate(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}…（共 ${text.length} 字符）` : text
}

export const definition = {
  name: 'd365_invoke',
  description:
    'Call one Dataverse action or function (e.g. WinOpportunity, contoso_DoSomething) and return the HTTP status and response body — to reproduce a failure or to see what a message returns. '
    + 'A GET function is a read and needs "读取业务数据" (data.read); a POST action needs "调用消息" (message.invoke), off by default, and is confirmed in the chat with its exact path and body. '
    + 'A failed call reports the status, the Dataverse error code and the body instead of throwing them away.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['message'],
    properties: {
      message: {
        type: 'string',
        description: '消息名，例如 WinOpportunity、RetrieveTotalRecordCount、contoso_DoSomething。',
      },
      method: {
        type: 'string',
        enum: ['POST', 'GET'],
        description: 'POST=action（默认，可带请求体）；GET=function（参数按 OData 别名拼进 URL，不能绑定记录）。',
      },
      entity: {
        type: 'string',
        description: '绑定 action 时必填：记录的实体集名（如 accounts）。',
      },
      id: {
        type: 'string',
        description: '绑定 action 时必填：记录主键 GUID。',
      },
      parameters: {
        type: 'object',
        description: 'POST 为请求体（action 的输入参数）；GET 为 function 的命名参数（值会按 OData 字面量格式化）。',
      },
      environment: {
        type: 'string',
        description: '环境 key，省略则用默认环境。',
      },
      rationale: {
        type: 'string',
        description: '为什么要调这条消息，会写进产物与执行记录。',
      },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
    render(_args, value) {
      return [{ type: 'text', text: value?.text ?? '' }]
    },
  },
}

export function register(ctx, state) {
  return ctx.tools.register({
    ...definition,
    async execute(args, exec) {
      const config = await loadConfig(state.rawConfig)
      const [env] = pickEnvironments(config, { environment: args.environment })
      if (!env) throw new D365Error('没有可用的环境', { code: 'no-environments' })

      const policy = await readPolicy(config.configFile)
      // A GET function only reads (RetrieveTotalRecordCount and friends), so it
      // belongs to `data.read`; a POST action runs plug-ins and needs the
      // separate `message.invoke` grant.
      const verb = String(args.method ?? 'POST').toUpperCase()
      const capability = verb === 'GET' ? 'data.read' : 'message.invoke'
      if (!allows(policy, env.key, capability)) {
        throw new D365Error(
          capability === 'data.read'
            ? `环境 ${env.key} 未授权读取业务数据`
            : `环境 ${env.key} 未授权调用消息`,
          {
            code: capability === 'data.read' ? 'data-read-forbidden' : 'message-invoke-forbidden',
            hint: `在设置页「D365 工具箱 → 权限」里给 ${env.key} 勾上${capability === 'data.read' ? '「读取业务数据」' : '「调用消息」'}后再试。`,
          },
        )
      }

      const request = buildInvokeRequest({
        message: args.message,
        method: args.method,
        entity: args.entity,
        id: args.id,
        parameters: args.parameters,
      })

      // A GET function changes nothing, so it runs without a card; a POST
      // action is confirmed every time because the target's plug-ins decide
      // what happens next.
      if (verb === 'POST') {
        const userQuestions = ctx.get('userQuestions')
        if (!userQuestions?.ask) {
          throw new D365Error('当前会话没有可用的确认界面', {
            hint: '调用消息必须在对话里确认；这个工具没有「不确认直接发」的路径。',
          })
        }
        if (!exec?.agent) throw new D365Error('需要可交互的会话', { hint: '请在主对话里调用。' })

        const answer = await userQuestions.ask({
          questions: [{
            id: CONFIRM_ID,
            header: `确认调用消息 ${env.key}`,
            question: `要在 ${env.key} 上调用 ${args.message}（${verb}）吗？`,
            detail: describeInvoke(env.key, args.message, verb, request.path, request.body),
            options: [
              { label: APPROVE, description: '立即调用一次' },
              { label: CANCEL, description: '不调用，什么都不发生' },
            ],
          }],
          agent: exec.agent,
          ...(exec.signal ? { signal: exec.signal } : {}),
          wait: { callId: exec.callId },
        })
        const chosen = answer?.answers?.find((item) => item.id === CONFIRM_ID)?.selected?.[0]
        if (chosen !== APPROVE) return { text: `未调用。${env.key} 没有收到任何消息。` }
      }

      const client = makeClient(env, config)
      const url = client.buildUrl(request.path, request.query)
      const started = Date.now()
      let status = 200
      let payload
      let failure
      try {
        payload = await client.requestJson(url, {
          method: verb,
          ...(verb === 'POST' ? { body: request.body ?? {} } : {}),
          capability: verb === 'POST' ? 'message.invoke' : undefined,
          headers: { Prefer: 'return=representation' },
          signal: exec?.signal,
        })
      } catch (error) {
        // The body of a failed call is the reason this tool exists: return it,
        // do not wrap it into something the caller has to unpack again.
        if (error?.code === 'http' || error?.status) {
          status = error.status ?? 0
          failure = error
          payload = error.body
        } else {
          throw error
        }
      }
      const elapsedMs = Date.now() - started

      const artifact = {
        kind: 'invoke',
        at: new Date().toISOString(),
        envKey: env.key,
        message: args.message,
        method: verb,
        path: request.path,
        query: request.query,
        body: request.body,
        status,
        elapsedMs,
        rationale: args.rationale,
        response: failure ? undefined : payload,
        error: failure ? { status, errorCode: failure.errorCode, body: failure.body } : undefined,
      }
      const file = await writeArtifact(config, `invoke-${String(args.message).replace(/[^a-zA-Z0-9._-]+/g, '-')}`, artifact)

      if (failure) {
        const parts = [
          `${env.key}：${args.message} 失败（HTTP ${status}，${elapsedMs}ms）`,
          failure.errorCode ? `错误码：${failure.errorCode}` : '',
          '',
          truncate(String(failure.body ?? failure.message ?? ''), 3000),
          '',
          `完整记录：${file}`,
        ].filter((line, index, all) => line !== '' || all[index - 1] !== '')
        return { text: parts.join('\n') }
      }

      const text = payload === null || payload === undefined ? '（无响应体）' : truncate(JSON.stringify(payload, null, 2), 3000)
      return {
        text: `${env.key}：${args.message} 成功（HTTP ${status}，${elapsedMs}ms）\n\n${text}\n\n完整记录：${file}`,
      }
    },
  })
}
