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
import { resolveLocale, translate } from './i18n.js'

export class D365Error extends Error {
  /**
   * @param message - what failed, in the operator's terms.
   * @param options - optional code, HTTP status, next-step hint, Dataverse
   *   error code, and the raw response body.
   */
  constructor(message, options = {}) {
    const translatedMessage = options.i18nKey
      ? translate(options.i18nKey, options.i18nParams, resolveLocale())
      : message
    const translatedHint = options.hintKey
      ? translate(options.hintKey, options.hintParams, resolveLocale())
      : options.hint
    const hint = translatedHint ? ` ${translate('error.hint', { hint: translatedHint }, resolveLocale())}` : ''
    super(translatedMessage + hint)
    this.name = 'D365Error'
    this.code = options.code
    this.status = options.status
    this.errorCode = options.errorCode
    this.body = options.body
    this.hint = translatedHint
    this.i18nKey = options.i18nKey
    this.i18nParams = options.i18nParams
    this.hintKey = options.hintKey
    this.hintParams = options.hintParams
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
  if (!body) return translate('error.emptyBody')
  const { message, code, inner } = pickErrorParts(body)
  const head = code ? `${code}: ${message ?? ''}` : String(message ?? JSON.stringify(body))
  const detail = inner && !head.includes(inner) ? translate('error.inner', { message: inner }) : ''
  const text = `${head}${detail}`
  return text.length > 900 ? `${text.slice(0, 900)}…` : text
}

/**
 * Build the hint for an HTTP failure: the status-specific advice first, then
 * the explanation of the Dataverse error code when the code is known.
 */
export function httpErrorHint({ status, body }) {
  const statusHint = status === 403
    ? translate('error.permission403')
    : status === 404
      ? translate('error.resource404')
      : undefined
  const codeHint = hintForErrorCode(errorCodeFromBody(body))
  return [statusHint, codeHint].filter(Boolean).join(' ') || undefined
}
