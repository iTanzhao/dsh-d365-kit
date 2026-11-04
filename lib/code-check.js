/**
 * Diff-driven code check: only what this merge request touches is inspected.
 *
 * The chain is: merge request → changed files → Dataverse component (web
 * resource / form event) → who references it → does the target environment
 * still satisfy what the changed lines assume.
 *
 * Scope discipline matters more than coverage here. Scanning every script in
 * the repository produces hundreds of pre-existing mismatches and buries the
 * one field this commit forgot to put on the form. So every finding carries
 * the changed line it came from, and nothing outside the diff is inspected.
 */
import { loadConfig } from './config.js'
import { DataverseClient } from './client.js'
import { D365Error } from './errors.js'
import { fetchMergeRequest } from './gitlab.js'
import { analyzeCsharpFile, isCsharpPath } from './csharp-check.js'
import { dataRoot } from './snapshot.js'
import { enforceRetention } from './retention.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Paths whose diff is inspectable. Everything else is reported, not parsed. */
const CODE_EXTENSIONS = new Set(['.js', '.ts'])

/** How a changed line reads values off the form. Compiled bundles use several. */
const ATTRIBUTE_PATTERNS = [
  /\bgetAttribute\(\s*["']([^"']+)["']/g,
  /\bgetControl\(\s*["']([^"']+)["']/g,
  /\.attributes\.get\(\s*["']([^"']+)["']/g,
  /\battributes\[\s*["']([^"']+)["']\s*\]/g,
  // Compiled bundles often go through a wrapper: ctx.getAttribute("x"),
  // this._formContext.data.entity.attributes.get("x").
  /\bdata\.entity\.attributes\.get\(\s*["']([^"']+)["']/g,
  /\bformContext\.getAttribute\(\s*["']([^"']+)["']/g,
  /\bXrm\.Page\.getAttribute\(\s*["']([^"']+)["']/g,
]

/**
 * `columns.get("x")` reads a view or sub-grid column, not a form field. Keeping
 * it out of the attribute list matters: a column that is not on the form is
 * normal, and treating it as a missing field turned every grid change into a
 * blocker.
 */
const COLUMN_PATTERNS = [/\.columns\.get\(\s*["']([^"']+)["']/g]

/** Bracket access with a publisher prefix: the shape is a name, nothing more. */
const GUESS_PATTERNS = [/\[["']([a-z][a-z0-9_]*_[a-z0-9_]+)["']\]/g]

const WEBAPI_PATTERN = /Xrm\.WebApi\.[A-Za-z]+\(\s*["']([^"']+)["']/g
const GUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const URL_PATTERN = /https?:\/\/[^\s"'`)]+/gi
const OPTION_PATTERN = /(?:===?|!==?)\s*(\d{6,9})\b/g
const FUNCTION_PATTERNS = [
  /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
  /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*function\b/g,
  /^([A-Za-z_$][\w$]*)\s*=\s*function\b/gm,
]

/** `OData` string literal: the only escape that matters is a single quote. */
function odataString(value) {
  return String(value).replace(/'/g, "''")
}

/** Last path segment; the mapping between repo paths and resource names is unreliable. */
function basename(path) {
  return String(path).split('/').filter(Boolean).pop() ?? ''
}

function extension(path) {
  const match = String(path).match(/\.[a-z0-9]+$/i)
  return match ? match[0].toLowerCase() : ''
}

/**
 * Split a unified diff into added and removed lines with their new-file line
 * numbers. Context lines are ignored: they are not this change's fault.
 */
export function parseDiff(diff) {
  const added = []
  const removed = []
  let newLine = 0
  for (const raw of String(diff ?? '').split('\n')) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      newLine = Number(hunk[1])
      continue
    }
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('\\')) continue
    if (raw.startsWith('+')) {
      added.push({ line: newLine, text: raw.slice(1) })
      newLine += 1
      continue
    }
    if (raw.startsWith('-')) {
      removed.push({ text: raw.slice(1) })
      continue
    }
    if (raw.length && !raw.startsWith('-')) newLine += 1
  }
  return { added, removed }
}

function collect(patterns, text) {
  const found = new Map()
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const value = match[1]
      if (value && !found.has(value)) found.set(value, match.index ?? 0)
    }
  }
  return [...found.keys()]
}

/** Every external thing the added lines touch in one changed file. */
export function extractReferences(addedLines) {
  const text = addedLines.map((entry) => entry.text).join('\n')
  const lineOf = (value) => addedLines.find((entry) => entry.text.includes(value))?.line ?? null
  const attributes = collect(ATTRIBUTE_PATTERNS, text).map((name) => ({ name, line: lineOf(name) }))
  const columns = collect(COLUMN_PATTERNS, text).map((name) => ({ name, line: lineOf(name) }))
  const guesses = collect(GUESS_PATTERNS, text)
    .filter((name) => !attributes.some((ref) => ref.name === name))
    .map((name) => ({ name, line: lineOf(name) }))
  const entities = [...new Set([...text.matchAll(WEBAPI_PATTERN)].map((m) => m[1]))]
  const guids = [...new Set([...text.matchAll(GUID_PATTERN)].map((m) => m[0].toLowerCase()))]
  const urls = [...new Set([...text.matchAll(URL_PATTERN)].map((m) => m[0]))]
  const optionValues = [...new Set([...text.matchAll(OPTION_PATTERN)].map((m) => Number(m[1])))]
  return { attributes, columns, guesses, entities, guids, urls, optionValues }
}

/** Function names a diff takes away — the ones whose removal breaks a form handler. */
export function extractRemovedFunctions(removedLines) {
  const text = removedLines.map((entry) => entry.text).join('\n')
  return collect(FUNCTION_PATTERNS, text)
}

/** Pick the resource a changed file most likely is, and say when it is a guess. */
async function mapWebResource(client, path, signal) {
  const base = basename(path)
  if (!base) return { resourceName: null, candidates: [], certain: false }
  const page = await client.getPaged('webresourceset', {
    $select: 'name',
    $filter: `contains(name,'${odataString(base)}')`,
  }, 100, signal)
  const names = page.records.map((row) => row.name).filter(Boolean)
  if (names.length === 1) return { resourceName: names[0], candidates: names, certain: true }
  if (!names.length) return { resourceName: null, candidates: [], certain: false }
  // Several resources share the basename: prefer one whose path suffix matches
  // the repository path, otherwise leave the choice to a human.
  const suffix = String(path).replace(/^\/+/, '')
  const suffixMatch = names.filter((name) => suffix.endsWith(name) || name.endsWith(suffix))
  if (suffixMatch.length === 1) return { resourceName: suffixMatch[0], candidates: names, certain: true }
  return { resourceName: suffixMatch[0] ?? names[0], candidates: names, certain: false }
}

/** Forms whose formxml binds this library, verified against the exact attribute. */
async function findFormConsumers(client, resourceName, signal) {
  const page = await client.getPaged('systemforms', {
    $select: 'name,type,objecttypecode,formxml',
    $filter: `contains(formxml,'${odataString(resourceName)}')`,
  }, 200, signal)
  return page.records.filter((row) =>
    String(row.formxml ?? '').includes(`libraryName="${resourceName}"`)
    || String(row.formxml ?? '').includes(`libraryName='${resourceName}'`))
}

/** Field names present on one form, plus the handlers it declares. */
export function describeForm(formxml) {
  const xml = String(formxml ?? '')
  const fields = new Set([...xml.matchAll(/datafieldname="([^"]+)"/gi)].map((m) => m[1]))
  const handlers = [...xml.matchAll(/<Handler\b[^>]*>/gi)].map((m) => {
    const functionName = m[0].match(/functionName="([^"]+)"/i)?.[1] ?? ''
    const libraryName = m[0].match(/libraryName="([^"]+)"/i)?.[1] ?? ''
    return { functionName, libraryName }
  })
  return { fields, handlers }
}

function attributeOnEntity(client, entity, attribute, signal) {
  return client.getPaged(`EntityDefinitions(LogicalName='${odataString(entity)}')/Attributes`, {
    $select: 'LogicalName,AttributeType',
    $filter: `LogicalName eq '${odataString(attribute)}'`,
  }, 1, signal).then((page) => page.records[0] ?? null).catch(() => null)
}

async function entityNames(client, signal) {
  const names = new Set()
  try {
    const page = await client.getPaged('EntityDefinitions', { $select: 'LogicalName' }, 3000, signal)
    for (const row of page.records) if (row.LogicalName) names.add(String(row.LogicalName).toLowerCase())
  } catch {
    // A tenant that refuses the metadata listing keeps this check silent.
  }
  return names
}

function resolveTargets(config, requested) {
  const keys = Object.keys(config.environments)
  const wanted = Array.isArray(requested) && requested.length ? requested : keys
  const unknown = wanted.filter((key) => !config.environments[key])
  if (unknown.length) {
    throw new D365Error(`未知环境：${unknown.join(', ')}`, {
      code: 'unknown-environment',
      hint: `可用环境：${keys.join(', ')}`,
    })
  }
  return wanted
}

/**
 * Analyze one merge request against the configured environments.
 *
 * @param config - loaded plugin config.
 * @param request - `{ mergeRequest, project?, targets? }`.
 * @returns a report object; findings are limited to lines the MR changed.
 */
/** Drop human items from `from` on that repeat an earlier object + question. */
function dropDuplicateHuman(human, from) {
  const seen = new Set(human.slice(0, from).map((item) => `${item.object}|${item.question}`))
  const kept = []
  for (let index = from; index < human.length; index += 1) {
    const item = human[index]
    const key = `${item.object}|${item.question}`
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(item)
  }
  human.length = from
  human.push(...kept)
}

export async function analyzeMergeRequest(config, request, signal) {
  const merge = await fetchMergeRequest(config, request, signal)
  const targetKeys = resolveTargets(config, request?.targets)

  const files = []
  const findings = []
  const human = []

  let humanId = 0
  const askHuman = (entry) => {
    humanId += 1
    human.push({ id: `HC-${String(humanId).padStart(2, '0')}`, ...entry })
  }

  const codeChanges = merge.changes.filter((change) => CODE_EXTENSIONS.has(extension(change.newPath)))
  for (const change of merge.changes) {
    if (CODE_EXTENSIONS.has(extension(change.newPath)) || isCsharpPath(change.newPath)) continue
    files.push({ path: change.newPath, kind: 'other', note: '非脚本文件，本次不做静态检查' })
  }

  for (const change of codeChanges) {
    const { added, removed } = parseDiff(change.diff)
    const refs = extractReferences(added)
    const removedFunctions = extractRemovedFunctions(removed)
    const fileReport = {
      path: change.newPath,
      kind: change.deletedFile ? 'deleted' : change.renamedFile ? 'renamed' : change.newFile ? 'added' : 'modified',
      addedLines: added.length,
      removedLines: removed.length,
      references: refs,
      removedFunctions,
      targets: [],
    }

    if (!added.length && !removed.length) {
      files.push(fileReport)
      continue
    }

    for (const targetKey of targetKeys) {
      const env = config.environments[targetKey]
      const client = new DataverseClient(env, { timeoutMs: config.timeoutMs })
      const targetReport = { target: targetKey, resourceName: null, candidates: [], certain: false, forms: [], findings: 0 }

      try {
        const mapping = await mapWebResource(client, change.newPath, signal)
        Object.assign(targetReport, mapping)
        if (!mapping.resourceName) {
          findings.push({
            severity: 'warning',
            target: targetKey,
            file: change.newPath,
            line: null,
            message: `在 ${targetKey} 找不到文件名匹配的 Web 资源（${basename(change.newPath)}）`,
          })
          askHuman({
            object: change.newPath,
            question: `这个文件在 ${targetKey} 对应哪个 Web 资源？`,
            evidence: `按文件名 '${basename(change.newPath)}' 搜索，没有命中。`,
            howToCheck: '在解决方案里找到该脚本的资源名，或在仓库里确认构建后的文件名。',
            impact: '映射不上就无法检查表单引用，改动的运行时影响未知。',
          })
          fileReport.targets.push(targetReport)
          continue
        }
        if (!mapping.certain) {
          askHuman({
            object: change.newPath,
            question: `这个文件对应 ${mapping.resourceName} 吗？候选：${mapping.candidates.join('、')}`,
            evidence: '按文件名匹配到多个资源，已按路径后缀选了最接近的一个。',
            howToCheck: '核对仓库路径与环境里的 Web 资源名。',
            impact: '映射错了，后面的检查对象就错了。',
          })
        }

        const forms = await findFormConsumers(client, mapping.resourceName, signal)
        targetReport.forms = forms.map((form) => ({
          name: form.name,
          type: form.type,
          entity: form.objecttypecode,
        }))

        if (change.deletedFile && forms.length) {
          findings.push({
            severity: 'blocker',
            target: targetKey,
            file: change.newPath,
            line: null,
            message: `删除了 Web 资源 ${mapping.resourceName}，${targetKey} 里仍有 ${forms.length} 张表单引用它`,
          })
        }

        // One library is usually bound to several forms, and a field only has to
        // exist on the forms that actually reach the changed line. Collect per
        // field and decide once: missing everywhere is a blocker, missing on
        // some of the forms is a warning, not a blocker per form.
        const fieldUsage = new Map()
        let entities = null
        for (const form of forms) {
          const { fields, handlers } = describeForm(form.formxml)
          const entity = String(form.objecttypecode ?? '')

          for (const ref of refs.attributes) {
            const entry = fieldUsage.get(ref.name) ?? { name: ref.name, line: ref.line, present: [], missing: [] }
            if (fields.has(ref.name)) entry.present.push(form.name)
            else entry.missing.push({ form: form.name, entity })
            fieldUsage.set(ref.name, entry)
          }

          for (const removedName of removedFunctions) {
            const hit = handlers.some((handler) => handler.functionName.split('.').pop() === removedName)
            if (!hit) continue
            findings.push({
              severity: 'blocker',
              target: targetKey,
              file: change.newPath,
              line: null,
              message: `删除了函数 ${removedName}，但 ${targetKey} 的表单「${form.name}」仍把它注册为事件处理函数`,
            })
          }
        }

        for (const entry of fieldUsage.values()) {
          if (!entry.missing.length) continue
          if (entry.present.length) {
            findings.push({
              severity: 'warning',
              target: targetKey,
              file: change.newPath,
              line: entry.line,
              message: `改动的代码读取了 ${entry.name}：${targetKey} 上 ${entry.present.length} 张表单有这个字段，另有 ${entry.missing.length} 张没有（${entry.missing.map((item) => item.form).slice(0, 3).join('、')}${entry.missing.length > 3 ? '…' : ''}）——确认脚本在这些表单上不会走到该分支`,
            })
            continue
          }
          findings.push({
            severity: 'blocker',
            target: targetKey,
            file: change.newPath,
            line: entry.line,
            message: `改动的代码读取了 ${entry.name}，但 ${targetKey} 上引用该库的 ${entry.missing.length} 张表单都没有这个字段`,
          })
          if (!entities) entities = await entityNames(client, signal)
          for (const { entity } of entry.missing) {
            if (!entity || entities.has(entity.toLowerCase())) continue
            askHuman({
              object: `${entity}.${entry.name}`,
              question: `表 ${entity} 在 ${targetKey} 不存在，确认实体名是否改过`,
              evidence: 'EntityDefinitions 里没有该实体。',
              howToCheck: '检查实体逻辑名与解决方案是否包含该表。',
              impact: '字段取值必然为 null，脚本会抛错。',
            })
          }
        }

        for (const ref of refs.columns ?? []) {
          askHuman({
            object: ref.name,
            question: `确认 ${ref.name} 是视图/子网格列，还是表单字段`,
            evidence: `改动行用 columns.get('${ref.name}') 取值；这个 API 读的是列，列不在表单上是正常的。`,
            howToCheck: '如果是表单字段，应改用 getAttribute；如果是列，确认视图或子网格在目标环境也有这一列。',
            impact: '列缺失时取值返回 null，不会报错，但界面会出现空白格。',
          })
        }

        for (const ref of refs.guesses ?? []) {
          askHuman({
            object: ref.name,
            question: `确认 ${ref.name} 在 ${targetKey} 里指的是字段、列还是别的键`,
            evidence: '改动行以带前缀的字符串下标取值，静态分析无法判断它是元数据还是普通对象键。',
            howToCheck: '在脚本上下文里看这个对象是什么；如果是表单字段，改用 getAttribute 以便下次能自动检查。',
            impact: '判断不了就可能漏掉一个真实的字段缺失。',
          })
        }

        // Entity names used through the Web API must exist in the target.
        if (refs.entities.length) {
          if (!entities) entities = await entityNames(client, signal)
          for (const name of refs.entities) {
            if (entities.has(name.toLowerCase())) continue
            findings.push({
              severity: 'blocker',
              target: targetKey,
              file: change.newPath,
              line: null,
              message: `改动的代码调用了 Xrm.WebApi 的 ${name}，${targetKey} 里没有这个实体`,
            })
          }
        }

        for (const url of refs.urls) {
          findings.push({
            severity: 'warning',
            target: targetKey,
            file: change.newPath,
            line: null,
            message: `硬编码地址 ${url}`,
          })
        }

        for (const guid of refs.guids) {
          askHuman({
            object: guid,
            question: `确认 ${guid} 在 ${targetKey} 里指的是同一条记录`,
            evidence: '代码里出现硬编码 GUID，静态检查无法判断它属于哪张表。',
            howToCheck: '在源码里找到它的用途（配置记录 / 团队 / 队列 / 视图），再到目标环境按表查。',
            impact: '记录不存在时运行时返回空或抛错。',
          })
        }

        if (refs.optionValues.length) {
          askHuman({
            object: refs.optionValues.join(', '),
            question: `确认这些选项值在 ${targetKey} 的选项集里存在`,
            evidence: '代码用数字与选项值比较，静态检查无法可靠判断是哪个字段。',
            howToCheck: '定位比较语句对应的字段，再到目标环境查该选项集的值域。',
            impact: '值不存在时分支永远不进入，功能静默失效。',
          })
        }

        targetReport.findings = findings.filter((entry) => entry.target === targetKey).length
      } catch (error) {
        findings.push({
          severity: 'warning',
          target: targetKey,
          file: change.newPath,
          line: null,
          message: `检查失败：${error.message}`,
        })
      }
      fileReport.targets.push(targetReport)
    }
    files.push(fileReport)
  }

  for (const change of merge.changes) {
    if (!isCsharpPath(change.newPath)) continue
    const { added, removed } = parseDiff(change.diff)
    if (!added.length && !removed.length) {
      files.push({ path: change.newPath, kind: 'csharp', addedLines: 0, removedLines: 0, targets: [] })
      continue
    }
    const beforeHuman = human.length
    const result = await analyzeCsharpFile({
      change: { newPath: change.newPath, added, removed },
      config,
      targetKeys,
      signal,
      askHuman,
    })
    files.push(result.file)
    findings.push(...result.findings)
    dropDuplicateHuman(human, beforeHuman)
  }

  human.forEach((item, index) => {
    item.id = `HC-${String(index + 1).padStart(2, '0')}`
  })

  return {
    project: merge.project,
    iid: merge.iid,
    title: merge.title,
    webUrl: merge.webUrl,
    sourceBranch: merge.sourceBranch,
    targetBranch: merge.targetBranch,
    targets: targetKeys,
    files,
    findings,
    human,
  }
}

/** Write the markdown report beside the other artifacts and return its path. */
export async function writeCodeCheckReport(config, report) {
  const directory = join(dataRoot(config), 'reports')
  await mkdir(directory, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(directory, `code-check-${report.iid}-${stamp}.md`)
  const lines = []
  lines.push(`# 代码改动影响检查 · MR !${report.iid}`, '')
  lines.push(`- 项目：${report.project}`)
  lines.push(`- 标题：${report.title || '（无标题）'}`)
  lines.push(`- 分支：${report.sourceBranch} → ${report.targetBranch}`)
  lines.push(`- 目标环境：${report.targets.join('、')}`)
  lines.push('')
  lines.push('## 改动的文件', '')
  for (const file of report.files) {
    lines.push(`- ${file.path}（${file.kind}）：+${file.addedLines ?? 0} / -${file.removedLines ?? 0}`)
  }
  lines.push('', '## 阻断与警告', '')
  if (!report.findings.length) lines.push('没有发现元数据层面的阻断项。')
  for (const finding of report.findings) {
    const where = finding.line ? `:${finding.line}` : ''
    lines.push(`- [${finding.severity}] ${finding.target} · ${finding.file}${where} — ${finding.message}`)
  }
  lines.push('', '## 需要人工确认', '')
  if (!report.human.length) lines.push('没有需要人工确认的条目。')
  for (const item of report.human) {
    lines.push(`### ${item.id} ${item.object}`, '')
    lines.push(`- 问题：${item.question}`)
    lines.push(`- 证据：${item.evidence}`)
    lines.push(`- 怎么确认：${item.howToCheck}`)
    lines.push(`- 影响：${item.impact}`)
    lines.push('')
  }
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
  return path
}

/** Load the config the plugin was given, then analyze. */
export async function runCodeCheck(rawConfig, request, signal) {
  const config = await loadConfig(rawConfig)
  const report = await analyzeMergeRequest(config, request, signal)
  const reportPath = await writeCodeCheckReport(config, report)
  await enforceRetention(config, { target: 'reports' })
  return { report, reportPath }
}
