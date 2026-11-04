/**
 * Contract matrix and drift rules.
 *
 * The matrix answers "which registration does the code imply, and does it
 * exist in every environment". The drift engine answers "which of the implied
 * things are missing or older downstream" — with a direction: upstream (the
 * source of the change) to downstream (targets).
 *
 * Both run on live queries rather than snapshots: plugin registration is small
 * enough to read directly, and a stale snapshot would produce false drift.
 */

import { D365Error } from './errors.js'
import { makeClient } from './runtime.js'
import { dataRoot } from './snapshot.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Rules are data: id, severity, title and a predicate over contract data. */
export const RULES = [
  {
    id: 'assembly-missing',
    severity: 'blocker',
    title: '下游环境缺少上游的自定义程序集',
  },
  {
    id: 'assembly-version-older',
    severity: 'warning',
    title: '下游程序集版本比上游旧',
  },
  {
    id: 'plugin-type-missing',
    severity: 'blocker',
    title: '下游环境缺少插件类型',
  },
  {
    id: 'plugin-step-missing',
    severity: 'blocker',
    title: '下游环境缺少插件步骤',
  },
  {
    id: 'option-value-missing',
    severity: 'warning',
    title: '下游选项集缺少上游的选项值',
  },
  {
    id: 'form-library-missing',
    severity: 'blocker',
    title: '表单引用的 Web 资源在环境里不存在',
  },
  {
    id: 'sitemap-missing',
    severity: 'warning',
    title: '下游缺少上游的自定义站点地图',
  },
  {
    id: 'handler-missing',
    severity: 'warning',
    title: '表单 Handler 指向的函数在脚本里找不到',
  },
]

function normalizeAssembly(name) {
  return String(name ?? '').toLowerCase().replace(/\.dll$/, '')
}

function compareVersion(left, right) {
  const a = String(left ?? '0').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const b = String(right ?? '0').split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

async function readAll(client, path, params, signal) {
  const rows = []
  let next = client.buildUrl(path, params)
  let pages = 0
  while (next && pages < 200) {
    const page = await client.requestJson(next, { signal })
    rows.push(...(page?.value ?? []))
    next = page?.['@odata.nextLink'] ?? null
    pages += 1
  }
  return rows
}

/** Read the registration facts a contract needs from one environment. */
export async function readContractFacts(client, signal, options = {}) {
  const assemblies = await readAll(client, 'pluginassemblies', {
    $select: 'pluginassemblyid,name,version,ismanaged,isolationmode',
  }, signal)
  const types = await readAll(client, 'plugintypes', {
    $select: 'plugintypeid,typename,_pluginassemblyid_value',
  }, signal)
  const steps = await readAll(client, 'sdkmessageprocessingsteps', {
    $select: 'sdkmessageprocessingstepid,_eventhandler_value,_sdkmessageid_value,stage,mode',
  }, signal)
  const messages = await readAll(client, 'sdkmessages', { $select: 'sdkmessageid,name' }, signal)

  const messageNames = new Map()
  for (const message of messages) messageNames.set(message.sdkmessageid, message.name)

  let forms = []
  let resources = []
  let sitemaps = []
  if (options.includeVisual !== false) {
    forms = await readAll(client, 'systemforms', { $select: 'name,objecttypecode,formxml' }, signal)
    resources = await readAll(client, 'webresourceset', { $select: 'name' }, signal)
    sitemaps = await readAll(client, 'sitemaps', { $select: 'sitemapname,ismanaged' }, signal)
  }

  const assemblyById = new Map()
  for (const assembly of assemblies) assemblyById.set(assembly.pluginassemblyid, assembly)

  const typeById = new Map()
  for (const type of types) {
    const assembly = assemblyById.get(type._pluginassemblyid_value)
    typeById.set(type.plugintypeid, {
      id: type.plugintypeid,
      name: type.typename,
      assembly: assembly?.name ?? null,
      assemblyId: type._pluginassemblyid_value ?? null,
    })
  }

  const stepsByType = new Map()
  for (const step of steps) {
    const type = typeById.get(step._eventhandler_value)
    if (!type) continue
    const message = messageNames.get(step._sdkmessageid_value) ?? 'unknown'
    const key = `${message}|${step.stage}|${step.mode}`
    if (!stepsByType.has(step._eventhandler_value)) stepsByType.set(step._eventhandler_value, new Set())
    stepsByType.get(step._eventhandler_value).add(key)
  }

  return { assemblies, types: [...typeById.values()], stepsByType, messageNames, forms, resources, sitemaps }
}

/** `libraryName="..."` values in a form definition, excluding embedded refs. */
export function librariesFrom(formxml) {
  const found = new Set()
  const pattern = /libraryName="([^"]+)"/g
  let match = pattern.exec(String(formxml ?? ''))
  while (match) {
    const name = match[1]
    if (name && !name.startsWith('$webresource:')) found.add(name)
    match = pattern.exec(String(formxml ?? ''))
  }
  return found
}

/**
 * Visual-layer drift: a form that loads a script the environment does not have
 * breaks at runtime even though every metadata table looks fine.
 */
export function compareVisualContract(upstream, downstreams) {
  const findings = []
  for (const downstream of downstreams) {
    const resources = new Set(downstream.facts.resources.map((item) => String(item.name).toLowerCase()))
    const reported = new Set()
    for (const form of downstream.facts.forms) {
      for (const library of librariesFrom(form.formxml)) {
        const key = library.toLowerCase()
        if (resources.has(key) || reported.has(key)) continue
        reported.add(key)
        findings.push(finding('form-library-missing', downstream.env, library,
          `表单「${form.name}」引用的库 ${library} 在 ${downstream.env} 不存在`,
          `objecttypecode ${form.objecttypecode ?? '—'}`))
      }
    }
  }
  const upstreamSitemaps = upstream.facts.sitemaps.filter((item) => item.ismanaged !== true)
  for (const downstream of downstreams) {
    const names = new Set(downstream.facts.sitemaps.map((item) => String(item.sitemapname)))
    for (const sitemap of upstreamSitemaps) {
      if (names.has(sitemap.sitemapname)) continue
      findings.push(finding('sitemap-missing', downstream.env, sitemap.sitemapname,
        `上游（${upstream.env}）有自定义站点地图 ${sitemap.sitemapname}，下游没有`))
    }
  }
  return findings
}

/** Normalised view: assembly name → version, type key → step keys. */
export function indexContract(facts) {
  const assemblies = new Map()
  for (const assembly of facts.assemblies) {
    assemblies.set(normalizeAssembly(assembly.name), {
      name: assembly.name,
      version: assembly.version,
      ismanaged: assembly.ismanaged === true,
    })
  }
  const types = new Map()
  for (const type of facts.types) {
    const key = `${normalizeAssembly(type.assembly)}|${type.name}`
    types.set(key, {
      name: type.name,
      assembly: normalizeAssembly(type.assembly),
      steps: facts.stepsByType.get(type.id) ?? new Set(),
    })
  }
  return { assemblies, types }
}

function finding(rule, env, object, message, evidence) {
  const meta = RULES.find((item) => item.id === rule)
  return { rule, severity: meta?.severity ?? 'warning', env, object, message, evidence: evidence ?? '' }
}

/**
 * Compare the upstream contract with one or more downstream environments.
 * Only assemblies that are unmanaged upstream are treated as contract: managed
 * ones come from Microsoft or a managed solution and cannot be changed locally.
 */
export function compareContracts(upstream, downstreams, options = {}) {
  const findings = []
  const rows = []
  const upstreamIndex = indexContract(upstream.facts)

  for (const downstream of downstreams) {
    const index = indexContract(downstream.facts)
    const counters = { assemblies: 0, types: 0, steps: 0 }
    rows.push({ env: downstream.env, assemblies: index.assemblies.size, types: index.types.size, steps: downstream.facts.stepsByType.size })

    for (const [key, assembly] of upstreamIndex.assemblies) {
      if (assembly.ismanaged && !options.includeManaged) continue
      const target = index.assemblies.get(key)
      if (!target) {
        counters.assemblies += 1
        findings.push(finding('assembly-missing', downstream.env, assembly.name,
          `上游（${upstream.env}）有程序集 ${assembly.name}，下游没有`))
        continue
      }
      if (compareVersion(target.version, assembly.version) < 0) {
        findings.push(finding('assembly-version-older', downstream.env, assembly.name,
          `${assembly.name}：上游 ${assembly.version} > 下游 ${target.version}`,
          `上游快照 ${upstream.env}`))
      }
    }

    for (const [key, type] of upstreamIndex.types) {
      const source = upstreamIndex.assemblies.get(type.assembly)
      if (source?.ismanaged && !options.includeManaged) continue
      const target = index.types.get(key)
      if (!target) {
        if (!index.assemblies.has(type.assembly)) continue
        counters.types += 1
        findings.push(finding('plugin-type-missing', downstream.env, type.name,
          `上游（${upstream.env}）注册了 ${type.name}，下游没有`, `程序集 ${type.assembly}`))
        continue
      }
      for (const stepKey of type.steps) {
        if (target.steps.has(stepKey)) continue
        counters.steps += 1
        const [message, stage, mode] = stepKey.split('|')
        findings.push(finding('plugin-step-missing', downstream.env, `${type.name} · ${message}`,
          `${type.name} 缺少 ${message} / stage ${stage} / mode ${mode} 的步骤`,
          `程序集 ${type.assembly}`))
      }
    }
  }

  return { findings, rows }
}

/** Read one global option set's values, for value drift. */
export async function readOptionValues(client, name, signal) {
  const url = client.buildUrl(`GlobalOptionSetDefinitions(Name='${name.replace(/'/g, "''")}')/Microsoft.Dynamics.CRM.OptionSetMetadata`)
  const payload = await client.requestJson(url, { signal })
  const definition = payload?.OptionSet ?? payload
  const values = new Map()
  for (const option of definition?.Options ?? []) {
    const label = option?.Label?.UserLocalizedLabel?.Label ?? option?.Label?.LocalizedLabels?.[0]?.Label ?? ''
    values.set(String(option.Value), label)
  }
  return values
}

/** Compare option values between upstream and downstream for named sets. */
export async function compareOptionValues(upstreamClient, downstreamClients, names, signal) {
  const findings = []
  for (const name of names) {
    const source = await readOptionValues(upstreamClient, name, signal).catch(() => null)
    if (!source) {
      findings.push(finding('option-value-missing', '—', name, `上游读不到选项集 ${name}`, null))
      continue
    }
    for (const { env, client } of downstreamClients) {
      const target = await readOptionValues(client, name, signal).catch(() => null)
      if (!target) {
        findings.push(finding('option-value-missing', env, name, `下游缺少选项集 ${name}`))
        continue
      }
      const missing = [...source.keys()].filter((value) => !target.has(value))
      const extra = [...target.keys()].filter((value) => !source.has(value))
      if (missing.length) {
        findings.push(finding('option-value-missing', env, name,
          `下游缺 ${missing.length} 个值：${missing.slice(0, 8).map((value) => `${value}=${source.get(value)}`).join(', ')}${missing.length > 8 ? ' …' : ''}`,
          `上游共 ${source.size} 个值，下游 ${target.size} 个`))
      }
      if (extra.length) {
        findings.push(finding('option-value-missing', env, name,
          `下游多 ${extra.length} 个上游没有的值：${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ' …' : ''}`,
          '下游比上游新，确认是否已经回灌'))
      }
    }
  }
  return findings
}

/** Build clients for the environments a call targets. */
export async function openContractClients(config, envKeys, signal) {
  const clients = new Map()
  for (const key of envKeys) {
    const env = config.environments[key]
    if (!env) throw new D365Error(`未知环境：${key}`, { hint: `可用：${Object.keys(config.environments).join(', ')}` })
    clients.set(key, makeClient(env, config))
  }
  return clients
}

const HANDLER_PATTERN = /<Handler\b[^>]*functionName="([^"]+)"[^>]*libraryName="([^"]+)"/g

/** Handlers a form xml points at: `{ functionName, libraryName }`. */
export function handlersFrom(formxml) {
  const found = []
  const text = String(formxml ?? '')
  let match = HANDLER_PATTERN.exec(text)
  while (match) {
    found.push({ functionName: match[1], libraryName: match[2] })
    match = HANDLER_PATTERN.exec(text)
  }
  HANDLER_PATTERN.lastIndex = 0
  return found
}

async function readResourceContent(client, name, signal) {
  const url = client.buildUrl('webresourceset', {
    $select: 'content',
    $filter: `name eq '${String(name).replace(/'/g, "''")}'`,
  })
  const page = await client.requestJson(url, { signal })
  const row = page?.value?.[0]
  if (!row?.content) return null
  return Buffer.from(row.content, 'base64').toString('utf8')
}

// Publishers that belong to the platform itself. Everything else is treated as
// project code, so a fresh install works against any organization without
// knowing its publisher prefix up front.
const PLATFORM_PREFIXES = new Set([
  'adx', 'crm', 'dynamics', 'microsoft', 'msdyn', 'msft', 'system',
])

function normalizePrefix(value) {
  const prefix = String(value ?? '').trim().toLowerCase()
  if (!prefix) return ''
  if (PLATFORM_PREFIXES.has(prefix.replace(/_+$/, ''))) return ''
  return prefix.endsWith('_') ? prefix : `${prefix}_`
}

/**
 * Work out the publisher prefixes that belong to the project, instead of asking
 * the user to hard-code them. Unmanaged solutions carry the project's own
 * publishers, so their `customizationprefix` values are exactly the prefixes
 * that script libraries and schema names use.
 *
 * A real organization also holds a few unmanaged solutions from partners and
 * samples (on one project: 1525 solutions from the project publisher, then 8,
 * 6 and a handful of ones from everybody else). Judging those libraries as
 * project code produced dozens of false "function missing" findings, because
 * vendor bundles are minified and their internal names are mangled. So only
 * the dominant prefixes are kept, and `handlerPrefixes` in the config can pin
 * the list exactly when the heuristic guesses wrong.
 */
const PREFIX_SHARE = 0.2
const MAX_PREFIXES = 5

export async function detectHandlerPrefixes(client, signal) {
  let solutions = []
  try {
    solutions = await readAll(client, 'solutions', {
      $select: 'uniquename',
      $filter: 'ismanaged eq false',
      $expand: 'publisherid($select=customizationprefix)',
    }, signal)
  } catch {
    solutions = []
  }

  const counts = new Map()
  for (const row of solutions) {
    const prefix = normalizePrefix(row?.publisherid?.customizationprefix)
    if (prefix) counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
  }

  if (!counts.size) {
    try {
      const publishers = await readAll(client, 'publishers', {
        $select: 'customizationprefix',
      }, signal)
      for (const row of publishers) {
        const prefix = normalizePrefix(row?.customizationprefix)
        if (prefix) counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
      }
    } catch {
      // leave the list empty; the caller reports that nothing was checked
    }
  }

  const ranked = [...counts].sort((a, b) => b[1] - a[1])
  const top = ranked[0]?.[1] ?? 0
  const threshold = Math.max(2, Math.ceil(top * PREFIX_SHARE))
  const prefixes = new Set(ranked.filter(([, count]) => count >= threshold).map(([prefix]) => prefix))
  if (prefixes.size > MAX_PREFIXES) {
    prefixes.clear()
    for (const [prefix] of ranked.slice(0, MAX_PREFIXES)) prefixes.add(prefix)
  }

  // `new` is the prefix the customizer hands out by default; a project that
  // never created a publisher of its own still owns those libraries.
  prefixes.add('new_')
  return [...prefixes].sort()
}

/**
 * Check that every handler a form registers exists in the script it points at.
 * This needs the resource content, so it is opt-in and bounded: only the first
 * `libraryLimit` script libraries referenced by forms are downloaded.
 *
 * The check looks at *every* library the form loads, not just the handler's own
 * one: form event handlers resolve in the form's shared script scope, so
 * `PDS_UI.onSaveProduct` declared on `product.js` may well be provided by
 * `msdyn_productdeterminationservice_ui` that the same form also loads. Looking
 * only at the handler's library produced false positives for exactly that case.
 */
export async function compareHandlers(clients, downstreams, signal, options = {}) {
  // SIT alone references ~156 distinct project libraries from forms, so a low
  // budget would silently turn later forms into "unreadable" warnings.
  const limit = Number.isFinite(options.libraryLimit) ? options.libraryLimit : 400
  // Only project libraries are worth judging: system forms attach handlers that
  // the platform injects itself (`absoluteurl_onchange`, `Main_Form_onload`),
  // and those never appear in the resource the form lists.
  const prefixes = (options.prefixes ?? []).map((item) => String(item).toLowerCase())
  const isProjectLibrary = (name) => prefixes.some((prefix) => String(name).toLowerCase().startsWith(prefix))
  const findings = []
  const seen = new Set()
  for (const downstream of downstreams) {
    const client = clients.get(downstream.env)
    const contents = new Map()
    let fetched = 0
    const load = async (name) => {
      const key = name.toLowerCase()
      if (contents.has(key)) return contents.get(key)
      if (fetched >= limit) return undefined
      fetched += 1
      let content = null
      try {
        content = await readResourceContent(client, name, signal)
      } catch {
        content = null
      }
      contents.set(key, content)
      return content
    }

    for (const form of downstream.facts.forms) {
      // Judge project handlers against the project libraries the same form
      // loads. Microsoft libraries are skipped on purpose: a handler in a
      // Microsoft library is platform-provided, and pulling every MS script in
      // burns the download budget until later forms read as "unknown".
      const libraries = [...librariesFrom(form.formxml)]
        .filter((name) => name.toLowerCase().endsWith('.js'))
        .filter((name) => isProjectLibrary(name))
      if (!libraries.length) continue
      const handlers = handlersFrom(form.formxml)
        .filter((handler) => handler.libraryName.toLowerCase().endsWith('.js'))
        .filter((handler) => isProjectLibrary(handler.libraryName))
      if (!handlers.length) continue

      // Resolve each handler against its own library first: that is one download
      // per distinct project library and answers almost every case. Only when the
      // name is missing there do we widen to the other project libraries the form
      // loads — the `PDS_UI` case, where a form-level name lives in a sibling lib.
      let unknown = 0
      const reportable = []
      for (const handler of handlers) {
        const own = await load(handler.libraryName)
        if (typeof own === 'string' && handlerLooksPresent(own.toLowerCase(), handler.functionName)) continue
        reportable.push(handler)
      }
      if (!reportable.length) continue

      const haystacks = []
      for (const library of libraries) {
        const content = await load(library)
        if (typeof content === 'string') haystacks.push(content.toLowerCase())
        else unknown += 1
      }
      if (!haystacks.length) continue

      for (const handler of reportable) {
        if (haystacks.some((haystack) => handlerLooksPresent(haystack, handler.functionName))) continue
        const key = `${handler.functionName}|${handler.libraryName}`.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        findings.push(finding('handler-missing', downstream.env, handler.functionName,
          `表单 Handler 指向的函数在它所在的脚本环境里找不到：${handler.functionName}`,
          unknown
            ? `表单「${form.name ?? '未命名'}」加载的 ${libraries.length} 个脚本里有 ${unknown} 个读不到内容（资源不存在或超出上限），无法完全确认；函数也可能由动态加载的脚本提供`
            : `表单「${form.name ?? '未命名'}」加载的 ${libraries.length} 个脚本里都没有这个名字（可能被改名、未部署，或由动态加载的脚本提供）`))
      }
    }
  }
  return findings
}

/**
 * Lenient presence check for a handler. Scripts are often minified or define
 * members through object literals (`LearnMoreDialog.OnLoad = ...`,
 * `OnLoad:function`), so we look for the full name, the last two segments and
 * the bare member name, case-insensitively.
 */
export function handlerLooksPresent(haystack, functionName) {
  const parts = String(functionName).split('.').filter(Boolean)
  const candidates = [functionName, parts.slice(-2).join('.'), parts[parts.length - 1]]
  return candidates.some((candidate) => candidate && haystack.includes(candidate.toLowerCase()))
}

export async function writeContractReport(config, report) {
  const directory = join(dataRoot(config), 'reports')
  await mkdir(directory, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonPath = join(directory, `contract-${stamp}.json`)
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8')
  return jsonPath
}

export function renderContractMarkdown(report) {
  const lines = []
  lines.push(`# 契约矩阵 / 漂移：${report.upstream} → ${report.targets.join(', ')}`)
  lines.push('')
  lines.push(`生成时间：${report.generatedAt}`)
  lines.push('')
  if (report.trend) {
    lines.push(`对比上次（${report.trend.comparedTo}）：新增 ${report.trend.added.length} 条，已消失 ${report.trend.fixed.length} 条。`)
    lines.push('')
  }
  if (report.waived) {
    lines.push(`已豁免 ${report.waived} 条。`)
    lines.push('')
  }
  lines.push('## 环境规模')
  lines.push('')
  lines.push('| 环境 | 程序集 | 插件类型 | 有步骤的类型 |')
  lines.push('| --- | --- | --- | --- |')
  for (const row of report.rows) {
    lines.push(`| ${row.env} | ${row.assemblies} | ${row.types} | ${row.steps} |`)
  }
  lines.push('')
  const bySeverity = { blocker: [], warning: [] }
  for (const item of report.findings) (bySeverity[item.severity] ?? bySeverity.warning).push(item)
  for (const [severity, title] of [['blocker', '阻断'], ['warning', '警告']]) {
    const items = bySeverity[severity]
    lines.push(`## ${title} ${items.length}`)
    lines.push('')
    if (!items.length) {
      lines.push('无。')
    } else {
      for (const item of items) {
        lines.push(`- [${item.env}] ${item.rule}：${item.message}${item.evidence ? `（${item.evidence}）` : ''}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}
