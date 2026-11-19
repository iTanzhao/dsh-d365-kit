/**
 * Dataverse error codes that are worth explaining on the spot.
 *
 * A `0x80048d19` with no interpretation costs a person an hour: the message
 * says the *shape* of one property is wrong, not which rule was broken. This
 * table turns the code into the next thing to check. It is deliberately small:
 * only codes whose cause is unambiguous get an entry, because a wrong hint is
 * worse than none.
 */
import { t } from './i18n.js'

export const ERROR_CODES = {
  '0x80048d19': {
    summary: t('errorCode.80048d19.summary'),
    hint: t('errorCode.80048d19.hint'),
  },
  '0x80060888': {
    summary: t('errorCode.80060888.summary'),
    hint: t('errorCode.80060888.hint'),
  },
  '0x80040216': {
    summary: t('errorCode.objectMissing.summary'),
    hint: t('errorCode.objectMissing.hint'),
  },
  '0x80040217': {
    summary: t('errorCode.objectMissing.summary'),
    hint: t('errorCode.objectMissing.hint'),
  },
  '0x80040333': {
    summary: t('errorCode.80040333.summary'),
    hint: t('errorCode.80040333.hint'),
  },
  '0x80044150': {
    summary: t('errorCode.80044150.summary'),
    hint: t('errorCode.80044150.hint'),
  },
  '0x80048423': {
    summary: t('errorCode.80048423.summary'),
    hint: t('errorCode.80048423.hint'),
  },
  '0x8004a0f6': {
    summary: t('errorCode.8004a0f6.summary'),
    hint: t('errorCode.8004a0f6.hint'),
  },
}

/** Pull the first `0x........` token out of a string. */
export function errorCodeFromText(text) {
  const match = /0x[0-9a-fA-F]{8}/.exec(String(text ?? ''))
  return match ? match[0].toLowerCase() : undefined
}

/**
 * Pull the Dataverse error code out of a decoded response body.
 * Dataverse puts it in `error.code`, but some endpoints put it in the message.
 */
export function errorCodeFromBody(body) {
  if (!body) return undefined
  if (typeof body === 'string') return errorCodeFromText(body)
  const root = body.error ?? body
  const code = root?.code ?? root?.Code ?? root?.errorcode
  if (typeof code === 'number') return `0x${code.toString(16).padStart(8, '0')}`
  if (code) {
    const text = errorCodeFromText(code)
    if (text) return text
  }
  return errorCodeFromText(root?.message ?? root?.Message)
}

/** @returns the explanation for a known code, or undefined. */
export function explainErrorCode(code) {
  const key = String(code ?? '').toLowerCase()
  return ERROR_CODES[key]
}

/** @returns a one-line hint for a known code, or undefined. */
export function hintForErrorCode(code) {
  const entry = explainErrorCode(code)
  if (!entry) return undefined
  return `${entry.summary} ${entry.hint}`
}
