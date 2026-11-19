import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const localeStorage = new AsyncLocalStorage()
const ROOT = fileURLToPath(new URL('../locale/', import.meta.url))
function loadDictionary(language) {
  const directory = join(ROOT, language)
  const files = ['runtime.json', 'settings.json', 'tools.json', 'reports.json', 'client.json']
  return Object.assign({}, ...files.flatMap((file) => {
    try {
      return [JSON.parse(readFileSync(join(directory, file), 'utf8'))]
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }))
}

const dictionaries = {
  en: loadDictionary('en'),
  zh: loadDictionary('zh'),
}

export function normalizeLocale(locale) {
  return String(locale ?? '').trim().toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function localeFromRequest(request) {
  const languages = String(request?.headers?.get?.('accept-language') ?? request?.headers?.get?.('Accept-Language') ?? '')
  const explicit = request?.headers?.get?.('x-dsh-locale') ?? request?.headers?.get?.('X-Dsh-Locale')
  return normalizeLocale(explicit || languages.split(',')[0])
}

export function resolveLocale(fallback = 'en') {
  return localeStorage.getStore()?.locale ?? normalizeLocale(fallback)
}

export function withLocale(locale, operation) {
  return localeStorage.run({ locale: normalizeLocale(locale) }, operation)
}

export function translate(key, params, locale) {
  const active = normalizeLocale(locale ?? resolveLocale())
  const template = dictionaries[active]?.[key] ?? dictionaries.en[key] ?? key
  if (!params) return String(template)
  return String(template).replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match)
}

export function t(key, params) {
  return translate(key, params)
}

export function runtimeDictionaryKeys() {
  return Object.keys(dictionaries.en).sort()
}

export function runtimeDictionaries() {
  return {
    en: { ...dictionaries.en },
    zh: { ...dictionaries.zh },
  }
}

export function localizeError(error, locale) {
  if (!error || typeof error !== 'object') return String(error ?? '')
  if (!error.i18nKey) return error.message ?? String(error)
  return translate(error.i18nKey, error.i18nParams, locale)
}

export function localizeTool(definition, state) {
  const execute = definition.execute
  return {
    ...definition,
    async execute(args, exec) {
      const locale = state?.locale ?? 'en'
      return withLocale(locale, () => execute.call(definition, args, exec))
    },
  }
}

export function setLocale(state, locale) {
  state.locale = normalizeLocale(locale)
  return state.locale
}

export function localizeText(text, locale) {
  return translate('raw.text', { text }, locale)
}
