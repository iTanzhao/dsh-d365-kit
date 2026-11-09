/**
 * Errors raised by the D365 metadata toolkit.
 *
 * Every message is written for the person reading the tool result, not for a
 * log file: it names the environment, what failed, and the one thing to check
 * next. `hint` is appended to the message so a model sees it too.
 *
 * A Dataverse failure carries two things a caller usually needs later and the
 * old implementation threw away: the numeric error code (`0x80048d19`) and the
 * raw body. Both are kept as fields so a renderer can show the code even when
 * the message was rewritten into Chinese.
 */
import { errorCodeFromBody, hintForErrorCode } from './error-codes.js'

export class D365Error extends Error {
  /**
   * @param message - what failed, in the operator's terms.
   * @param options - optional code, HTTP status, next-step hint, Dataverse
   *   error code, and the raw response body.
   */
  constructor(message, options = {}) {
    const hint = options.hint ? ` 建议：${options.hint}` : ''
    super(message + hint)
    this.name = 'D365Error'
    this.code = options.code
    this.status = options.status
    this.errorCode = options.errorCode
    this.body = options.body
  }
}

/**
 * Reduce an error payload to its three useful parts.
 *
 * Dataverse nests a lot: `error.message` often contains the exception plus an
 * `InnerException : ...` tail, and the code lives beside it. Keeping only
 * `message` loses the part that says *why*.
 * @returns `{ message, code, inner }`
 */
function pickErrorParts(body) {
  if (!body) return { message: '', code: undefined, inner: undefined }
  if (typeof body === 'string') return { message: body, code: errorCodeFromBody(body), inner: undefined }
  const root = body.error ?? body
  const message = root?.message ?? root?.Message
  const code = root?.code ?? root?.Code ?? root?.errorcode
  const inner = root?.innererror?.message ?? root?.innererror?.Message ?? root?.InnerException
  return {
    message: typeof message === 'string' ? message : message === undefined ? undefined : JSON.stringify(message),
    code,
    inner: typeof inner === 'string' ? inner : undefined,
  }
}

/**
 * Normalize whatever a Dataverse error response carried into one line, keeping
 * the error code and the inner exception when the body has them.
 * @param body - parsed response body, or a raw string when parsing failed.
 * @returns a single-line message.
 */
export function describeDataverseError(body) {
  if (!body) return '（响应体为空）'
  const { message, code, inner } = pickErrorParts(body)
  const head = code ? `${code}: ${message ?? ''}` : String(message ?? JSON.stringify(body))
  const detail = inner && !head.includes(inner) ? `（内部：${inner}）` : ''
  const text = `${head}${detail}`
  return text.length > 900 ? `${text.slice(0, 900)}…` : text
}

/**
 * Build the hint for an HTTP failure: the status-specific advice first, then
 * the explanation of the Dataverse error code when the code is known.
 */
export function httpErrorHint({ status, body }) {
  const statusHint = status === 403
    ? '应用用户缺少该表的读取权限，检查其安全角色。'
    : status === 404
      ? '该资源在此环境不存在（不同环境可用性不同，属常见现象）。'
      : undefined
  const codeHint = hintForErrorCode(errorCodeFromBody(body))
  return [statusHint, codeHint].filter(Boolean).join(' ') || undefined
}
