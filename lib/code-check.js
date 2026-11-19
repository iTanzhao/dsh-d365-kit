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
import { t } from './i18n.js'
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
 * Why a changed file could not be inspected, or null when its diff is present.
 *
 * GitLab omits or truncates the diff of very large files. Without this the file
 * has no added/removed lines, which used to read exactly like "nothing changed"
 * and let the report say there was nothing to block.
 */
export function missingDiffReason(change) {
  if (!change) return null
  if (change.diffMissing !== true && String(change.diff ?? '').trim()) return null
  return change.tooLarge
    ? t('codeCheck.diffTooLarge')
    : t('codeCheck.diffMissing')
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
    // A file header is `+++ `/`--- `/`diff --git `; an added line can also start
    // with `+++` (`+++i;`), so only the exact header forms may be skipped.
    if (raw.startsWith('+++ ') || raw.startsWith('--- ') || raw.startsWith('diff --git ')) continue
    if (raw.startsWith('\\')) continue
    if (raw.startsWith('+')) {
      added.push({ line: newLine, text: raw.slice(1) })
      newLine += 1
      continue
    }
    if (raw.startsWith('-')) {
      removed.push({ text: raw.slice(1) })
      continue
    }
    if (raw.length) newLine += 1
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

/**
 * Does this form load the given library?
 *
 * Older formxml binds libraries through `libraryName="..."`, modern forms list
 * every dependency as `<Library name="..." />` under `<formLibraries>`; the
 * attribute form alone hid the library from the deleted-resource blocker and
 * from the field checks.
 */
export function formBindsLibrary(formxml, resourceName) {
  const xml = String(formxml ?? '')
  if (!xml) return false
  if (xml.includes(`libraryName="${resourceName}"`) || xml.includes(`libraryName='${resourceName}'`)) return true
  const wanted = String(resourceName).toLowerCase()
  for (const match of xml.matchAll(/<Library\b[^>]*\bname="([^"]+)"/gi)) {
    if (match[1].toLowerCase() === wanted) return true
  }
  return false
}

/**
 * Forms whose formxml binds this library, verified against the exact reference.
 * `truncated` is true when the server had more matching forms than were read.
 */
async function findFormConsumers(client, resourceName, signal) {
  const page = await client.getPaged('systemforms', {
    $select: 'name,type,objecttypecode,formxml',
    $filter: `contains(formxml,'${odataString(resourceName)}')`,
  }, 200, signal)
  return {
    forms: page.records.filter((row) => formBindsLibrary(row.formxml, resourceName)),
    truncated: page.hasMore === true,
  }
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

/**
 * Every logical table name in the environment.
 *
 * A failed read is reported, not swallowed: an empty set would make every
 * `Xrm.WebApi` entity look missing, and a truncated one would hide tables.
 * @returns `{ names, ok, truncated }`.
 */
async function entityNames(client, signal) {
  const names = new Set()
  try {
    // `EntityDefinitions` rejects $top; without the opt-out every check would
    // spend a 400 first and fall into the catch below, reporting "could not
    // read the table list" for an org that answered fine.
    const page = await client.getPaged('EntityDefinitions', { __noTop: true, $select: 'LogicalName' }, 3000, signal)
    for (const row of page.records) if (row.LogicalName) names.add(String(row.LogicalName).toLowerCase())
    return { names, ok: true, truncated: page.hasMore === true }
  } catch {
    return { names, ok: false, truncated: false }
  }
}

function resolveTargets(config, requested) {
  const keys = Object.keys(config.environments)
  const wanted = Array.isArray(requested) && requested.length ? requested : keys
  const unknown = wanted.filter((key) => !config.environments[key])
  if (unknown.length) {
    throw new D365Error(t('codeCheck.unknownEnv',{values:unknown.join(', ')}), {
      code: 'unknown-environment',
      hint: t('codeCheck.availableEnv',{values:keys.join(', ')}),
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
    files.push({ path: change.newPath, kind: 'other', note: t('codeCheck.notScript') })
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
    const missing = missingDiffReason(change)
    if (missing) fileReport.unverified = missing

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
            message: t('codeCheck.resourceNotFound',{env:targetKey,file:basename(change.newPath)}),
          })
          askHuman({
            object: change.newPath,
            question: t('codeCheck.resourceQuestion',{env:targetKey}),
            evidence: t('codeCheck.resourceEvidence',{file:basename(change.newPath)}),
            howToCheck: t('codeCheck.resourceHow'),
            impact: t('codeCheck.resourceImpact'),
          })
          fileReport.targets.push(targetReport)
          continue
        }
        if (!mapping.certain) {
          askHuman({
            object: change.newPath,
            question: t('codeCheck.ambiguousQuestion',{resource:mapping.resourceName,candidates:mapping.candidates.join(', ')}),
            evidence: t('codeCheck.ambiguousEvidence'),
            howToCheck: t('codeCheck.ambiguousHow'),
            impact: t('codeCheck.ambiguousImpact'),
          })
        }

        // Entity metadata is read at most once per file/target, and only when a
        // rule actually needs it. `ok` is false when the read failed: the name
        // of a table must then stay unverified instead of "missing".
        let entities = null
        const readEntities = async () => {
          if (!entities) {
            entities = await entityNames(client, signal)
            if (entities.truncated) {
              findings.push({
                severity: 'warning',
                target: targetKey,
                file: change.newPath,
                line: null,
                message: t('codeCheck.entityTruncated'),
              })
            }
          }
          return entities
        }

        const { forms, truncated: formsTruncated } = await findFormConsumers(client, mapping.resourceName, signal)
        targetReport.forms = forms.map((form) => ({
          name: form.name,
          type: form.type,
          entity: form.objecttypecode,
        }))
        if (formsTruncated) {
          findings.push({
            severity: 'warning',
            target: targetKey,
            file: change.newPath,
            line: null,
            message: t('codeCheck.formsTruncated'),
          })
        }

        if (change.deletedFile && forms.length) {
          findings.push({
            severity: 'blocker',
            target: targetKey,
            file: change.newPath,
            line: null,
            message: t('codeCheck.deletedResource',{resource:mapping.resourceName,env:targetKey,count:forms.length}),
          })
        }

        // One library is usually bound to several forms, and a field only has to
        // exist on the forms that actually reach the changed line. Collect per
        // field and decide once: missing everywhere is a blocker, missing on
        // some of the forms is a warning, not a blocker per form.
        const fieldUsage = new Map()
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
              message: t('codeCheck.removedHandler',{name:removedName,env:targetKey,form:form.name}),
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
              message: t('codeCheck.partialField',{name:entry.name,env:targetKey,present:entry.present.length,missing:entry.missing.length,sample:entry.missing.map((item)=>item.form).slice(0,3).join(', '),more:entry.missing.length>3?'…':''}),
            })
            continue
          }
          findings.push({
            severity: 'blocker',
            target: targetKey,
            file: change.newPath,
            line: entry.line,
            message: t('codeCheck.missingField',{name:entry.name,env:targetKey,count:entry.missing.length}),
          })
          const index = await readEntities()
          for (const { entity } of entry.missing) {
            if (!entity || !index.ok) continue
            if (index.names.has(entity.toLowerCase())) continue
            askHuman({
              object: `${entity}.${entry.name}`,
              question: t('codeCheck.entityQuestion',{entity,env:targetKey}),
              evidence: t('codeCheck.entityEvidence'),
              howToCheck: t('codeCheck.entityHow'),
              impact: t('codeCheck.entityImpact'),
            })
          }
        }

        for (const ref of refs.columns ?? []) {
          askHuman({
            object: ref.name,
            question: t('codeCheck.columnQuestion',{name:ref.name}),
            evidence: t('codeCheck.columnEvidence',{name:ref.name}),
            howToCheck: t('codeCheck.columnHow'),
            impact: t('codeCheck.columnImpact'),
          })
        }

        for (const ref of refs.guesses ?? []) {
          askHuman({
            object: ref.name,
            question: t('codeCheck.guessQuestion',{name:ref.name,env:targetKey}),
            evidence: t('codeCheck.guessEvidence'),
            howToCheck: t('codeCheck.guessHow'),
            impact: t('codeCheck.guessImpact'),
          })
        }

        // Entity names used through the Web API must exist in the target. When
        // the table list itself could not be read, "no such entity" is a claim
        // that was never verified: it becomes one human item, not N blockers.
        if (refs.entities.length) {
          const index = await readEntities()
          if (!index.ok) {
            askHuman({
              object: change.newPath,
              question: t('codeCheck.entityReadQuestion',{env:targetKey,names:refs.entities.join(', ')}),
              evidence: t('codeCheck.entityReadEvidence'),
              howToCheck: t('codeCheck.entityReadHow'),
              impact: t('codeCheck.entityReadImpact'),
            })
          } else {
            for (const name of refs.entities) {
              if (index.names.has(name.toLowerCase())) continue
              findings.push({
                severity: 'blocker',
                target: targetKey,
                file: change.newPath,
                line: null,
                message: t('codeCheck.entityMissing',{name,env:targetKey}),
              })
            }
          }
        }

        for (const url of refs.urls) {
          findings.push({
            severity: 'warning',
            target: targetKey,
            file: change.newPath,
            line: null,
            message: t('codeCheck.hardcodedUrl',{url}),
          })
        }

        for (const guid of refs.guids) {
          askHuman({
            object: guid,
            question: t('codeCheck.guidQuestion',{guid,env:targetKey}),
            evidence: t('codeCheck.guidEvidence'),
            howToCheck: t('codeCheck.guidHow'),
            impact: t('codeCheck.guidImpact'),
          })
        }

        if (refs.optionValues.length) {
          askHuman({
            object: refs.optionValues.join(', '),
            question: t('codeCheck.optionQuestion',{env:targetKey}),
            evidence: t('codeCheck.optionEvidence'),
            howToCheck: t('codeCheck.optionHow'),
            impact: t('codeCheck.optionImpact'),
          })
        }

        targetReport.findings = findings.filter((entry) => entry.target === targetKey).length
      } catch (error) {
        findings.push({
          severity: 'warning',
          target: targetKey,
          file: change.newPath,
          line: null,
          message: t('codeCheck.checkFailed',{message:error.message}),
        })
      }
      fileReport.targets.push(targetReport)
    }
    files.push(fileReport)
  }

  for (const change of merge.changes) {
    if (!isCsharpPath(change.newPath)) continue
    const { added, removed } = parseDiff(change.diff)
    const missing = missingDiffReason(change)
    if (!added.length && !removed.length) {
      const entry = { path: change.newPath, kind: 'csharp', addedLines: 0, removedLines: 0, targets: [] }
      if (missing) entry.unverified = missing
      files.push(entry)
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
    if (missing) result.file.unverified = missing
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
  lines.push(t('codeCheck.reportTitle', { iid: report.iid }), '')
  lines.push(t('codeCheck.project', { value: report.project }))
  lines.push(t('codeCheck.title', { value: report.title || t('codeCheck.untitled') }))
  lines.push(t('codeCheck.branches', { source: report.sourceBranch, target: report.targetBranch }))
  lines.push(t('codeCheck.targets', { values: report.targets.join(', ') }))
  lines.push('', t('codeCheck.filesHeading'), '')
  const unverified = report.files.filter((file) => file.unverified)
  for (const file of report.files) lines.push(t('codeCheck.fileRow', { path: file.path, kind: file.kind, added: file.addedLines ?? 0, removed: file.removedLines ?? 0, note: file.unverified ? t('codeCheck.unverified') : '' }))
  if (unverified.length) {
    lines.push('', t('codeCheck.unverifiedHeading'), '')
    for (const file of unverified) lines.push(`- ${file.path} — ${file.unverified}`)
  }
  lines.push('', t('codeCheck.findingsHeading'), '')
  if (!report.findings.length) lines.push(unverified.length ? t('codeCheck.noBlockersWithUnverified', { count: unverified.length }) : t('codeCheck.noBlockers'))
  for (const finding of report.findings) {
    const where = finding.line ? `:${finding.line}` : ''
    lines.push(`- [${finding.severity}] ${finding.target} · ${finding.file}${where} — ${finding.message}`)
  }
  lines.push('', t('codeCheck.humanHeading'), '')
  if (!report.human.length) lines.push(t('codeCheck.noHuman'))
  for (const item of report.human) {
    lines.push(`### ${item.id} ${item.object}`, '')
    lines.push(t('codeCheck.question', { value: item.question }))
    lines.push(t('codeCheck.evidence', { value: item.evidence }))
    lines.push(t('codeCheck.how', { value: item.howToCheck }))
    lines.push(t('codeCheck.impact', { value: item.impact }))
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
