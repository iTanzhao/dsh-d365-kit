/**
 * Errors raised by the D365 metadata toolkit.
 *
 * Every message is written for the person reading the tool result, not for a
 * log file: it names the environment, what failed, and the one thing to check
 * next. `hint` is appended to the message so a model sees it too.
 */
export class D365Error extends Error {
  /**
   * @param message - what failed, in the operator's terms.
   * @param options - optional code, HTTP status, and a next-step hint.
   */
  constructor(message, options = {}) {
    const hint = options.hint ? ` 建议：${options.hint}` : ''
    super(message + hint)
    this.name = 'D365Error'
    this.code = options.code
    this.status = options.status
  }
}

/**
 * Normalize whatever a Dataverse error response carried into one line.
 * @param body - parsed response body, or a raw string when parsing failed.
 * @returns a single-line message.
 */
export function describeDataverseError(body) {
  if (!body) return '（响应体为空）'
  if (typeof body === 'string') return body.slice(0, 500)
  const error = body.error ?? body
  const message = error?.message ?? error?.Message ?? JSON.stringify(body)
  const code = error?.code ?? error?.Code
  return code ? `${code}: ${message}` : String(message)
}
