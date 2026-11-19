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
import { t } from './i18n.js'

const CONFIRM_ID = 'd365-invoke-confirm'
const APPROVE = () => t('invoke.approve')
const CANCEL = () => t('invoke.cancel')
const ALLOWED_METHODS = ['POST', 'GET']
/** A message name is one path segment: no slash, no query, no `..`. */
const MESSAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/
/** An entity set name is one path segment too (`accounts`, `contoso_orders`). */
const ENTITY_SET = /^[A-Za-z][A-Za-z0-9_]*$/
/** A record id is a GUID. Bound actions cannot use an alternate key here. */
const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Function parameter aliases become query keys; keep them to plain names. */
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

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
  if (!name) throw new D365Error('message cannot be empty', { code: 'missing-message', i18nKey: 'invoke.messageRequired', hintKey: 'invoke.messageRequiredHint' })
  if (!MESSAGE_NAME.test(name)) {
    throw new D365Error(`Invalid message name: ${name}`, { code: 'bad-message', i18nParams: { name }, i18nKey: 'invoke.badMessage', hintKey: 'invoke.badMessageHint' })
  }
  const verb = String(method ?? 'POST').toUpperCase()
  if (!ALLOWED_METHODS.includes(verb)) {
    throw new D365Error(`Unsupported method: ${method}`, { code: 'bad-method', i18nParams: { method }, i18nKey: 'invoke.badMethod', hintKey: 'invoke.badMethodHint' })
  }
  if (verb === 'GET' && (entity || id)) {
    throw new D365Error('GET function cannot be bound to a record', { code: 'bad-binding', i18nKey: 'invoke.badBinding', hintKey: 'invoke.badBindingHint' })
  }

  const entitySet = entity === undefined ? '' : String(entity).trim()
  if (entitySet) {
    if (!ENTITY_SET.test(entitySet)) {
      throw new D365Error(`Invalid entity-set name: ${entitySet}`, { code: 'bad-entity', i18nParams: { entitySet }, i18nKey: 'invoke.badEntity', hintKey: 'invoke.badEntityHint' })
    }
    const recordId = String(id ?? '').trim()
    if (!RECORD_ID.test(recordId)) {
      throw new D365Error('A bound action requires a record GUID', { code: 'bad-id', i18nKey: 'invoke.idRequired', hintKey: 'invoke.idRequiredHint' })
    }
    return { path: `${entitySet}(${recordId})/Microsoft.Dynamics.CRM.${name}`, query: {}, body: bodyOf(verb, parameters) }
  }

  if (verb === 'POST') {
    return { path: name, query: {}, body: bodyOf(verb, parameters) }
  }

  const entries = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
    ? Object.entries(parameters)
    : []
  const query = {}
  const args = entries.map(([key, value], index) => {
    if (!PARAM_NAME.test(key)) {
      throw new D365Error(`Invalid function parameter name: ${key}`, { code: 'bad-parameter', i18nParams: { key }, i18nKey: 'invoke.badParameter', hintKey: 'invoke.badParameterHint' })
    }
    const alias = `@p${index}`
    query[alias] = odataLiteral(value)
    return `${key}=${alias}`
  })
  return { path: `${name}(${args.join(',')})`, query, body: undefined }
}

/** A POST body must be a plain object; anything else would be a client-side surprise. */
function bodyOf(verb, parameters) {
  if (verb !== 'POST') return undefined
  return parameters && typeof parameters === 'object' && !Array.isArray(parameters) ? parameters : {}
}

/** Human-readable one-liner for the confirmation card. */
export function describeInvoke(envKey, message, method, path, body) {
  const verb = String(method ?? 'POST').toUpperCase()
  const lines = [
    `${t('invoke.environment')}: ${envKey}`,
    `${t('invoke.message')}: ${message} (${verb})`,
    `${t('invoke.path')}: /${path}`,
  ]
  if (body !== undefined) {
    const text = JSON.stringify(body, null, 2)
    lines.push(t('invoke.requestBody'), text.length > 1200 ? `${text.slice(0, 1200)}…` : text)
  }
  lines.push(
    '',
    t('invoke.effectsWarning'),
  )
  return lines.join('\n')
}

function truncate(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}… (${text.length} characters total)` : text
}

export const definition = {
  name: 'd365_invoke',
  description:
    'Invoke one Dataverse action or function (such as WinOpportunity or contoso_DoSomething), returning HTTP status and response body for reproducing failures or inspecting the message result.'
    + 'GET functions require data.read. POST actions require both message.invoke and data.write, both disabled by default, and show the exact path and body for confirmation.'
    + 'Message and entity-set names are validated; bound actions require a GUID. Failures report the HTTP status, Dataverse error code, and response body.'
    + 'Sends exactly one Dataverse message; use d365_data for records and d365_metadata for definitions.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['message'],
    properties: {
      message: {
        type: 'string',
        description: 'Message name, such as WinOpportunity or contoso_DoSomething.',
      },
      method: {
        type: 'string',
        enum: ['POST', 'GET'],
        description: 'POST is an action (default, optional request body); GET is a function whose parameters are OData aliases and cannot bind a record.',
      },
      entity: {
        type: 'string',
        description: 'Required for a bound action: record collection name, such as accounts.',
      },
      id: {
        type: 'string',
        description: 'Required for a bound action: primary-key GUID.',
      },
      parameters: {
        type: 'object',
        description: 'For POST: action input body. For GET: named function parameters formatted as OData literals.',
      },
      environment: {
        type: 'string',
        description: 'Environment key; the configured default is used when omitted.',
      },
      rationale: {
        type: 'string',
        description: 'Why this message is invoked; recorded in the artifact and execution log.',
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
      if (!env) throw new D365Error('No environment is available', { code: 'no-environments', i18nKey: 'invoke.noEnvironment' })

      const policy = await readPolicy(config.configFile)
      // A GET function only reads (RetrieveTotalRecordCount and friends), so it
      // belongs to `data.read`. A POST action runs whatever plug-ins the message
      // has — those may create or change business data — so it needs the
      // separate `message.invoke` grant *and* the ordinary data-write grant.
      const verb = String(args.method ?? 'POST').toUpperCase()
      const capability = verb === 'GET' ? 'data.read' : 'message.invoke'
      if (!allows(policy, env.key, capability)) {
        throw new D365Error(
          capability === 'data.read'
            ? t('invoke.readForbidden', { environment: env.key })
            : t('invoke.invokeForbidden', { environment: env.key }),
          {
            code: capability === 'data.read' ? 'data-read-forbidden' : 'message-invoke-forbidden',
            hintKey: 'invoke.enableCapability', hintParams: { capability, environment: env.key },
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
          throw new D365Error('No confirmation UI is available in this session', { i18nKey: 'invoke.noConfirmationUi', hintKey: 'invoke.noConfirmationUiHint' })
        }
        if (!exec?.agent) throw new D365Error('An interactive session is required', { i18nKey: 'invoke.interactiveRequired', hintKey: 'invoke.interactiveRequiredHint' })

        const answer = await userQuestions.ask({
          questions: [{
            id: CONFIRM_ID,
            header: t('invoke.confirmHeader', { environment: env.key }),
            question: t('invoke.confirmQuestion', { message: args.message, verb, environment: env.key }),
            detail: describeInvoke(env.key, args.message, verb, request.path, request.body),
            options: [
              { label: APPROVE(), description: t('invoke.approveDescription') },
              { label: CANCEL(), description: t('invoke.cancelDescription') },
            ],
          }],
          agent: exec.agent,
          ...(exec.signal ? { signal: exec.signal } : {}),
          wait: { callId: exec.callId },
        })
        const chosen = answer?.answers?.find((item) => item.id === CONFIRM_ID)?.selected?.[0]
        if (chosen !== APPROVE()) return { text: t('invoke.notInvoked', { environment: env.key }) }
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
          t('invoke.failed', { environment: env.key, message: args.message, status, elapsedMs }),
          failure.errorCode ? t('invoke.errorCode', { code: failure.errorCode }) : '',
          '',
          truncate(String(failure.body ?? failure.message ?? ''), 3000),
          '',
          t('invoke.fullRecord', { file }),
        ].filter((line, index, all) => line !== '' || all[index - 1] !== '')
        return { text: parts.join('\n') }
      }

      const text = payload === null || payload === undefined ? t('invoke.noBody') : truncate(JSON.stringify(payload, null, 2), 3000)
      return {
        text: `${t('invoke.succeeded', { environment: env.key, message: args.message, status, elapsedMs })}\n\n${text}\n\n${t('invoke.fullRecord', { file })}`,
      }
    },
  })
}
