/**
 * C# side of `d365_code_check`: turn a plugin source change into checks against
 * a target environment.
 *
 * The source tells us *what* changed (classes, images, literals); the
 * environment tells us *what is registered* (assembly, plugin types, steps,
 * images, filtering attributes). Nothing here can prove the DLL in the
 * environment matches the commit — that is what the human list is for.
 */

import { DataverseClient, getPagedWithSelectFallback } from './client.js'
import { readAll } from './refs.js'
import { odataString } from './resources.js'
import { compareVersion } from './contract.js'
import { t } from './i18n.js'

const CS_PATH = /\.(cs|csproj|projitems|csproj\.user)$/i

/** True for files this module knows how to read. */
export function isCsharpPath(path) {
  return CS_PATH.test(String(path ?? ''))
}

const CLASS_PATTERN = /^\s*(?:public|internal|private|protected)?\s*(?:sealed\s+|static\s+|partial\s+|abstract\s+)*class\s+([A-Za-z_]\w*)\s*(?::\s*([^{]+))?/
const IMAGE_PATTERN = /\b(Pre|Post)EntityImages\s*\[\s*"([^"]+)"\s*\]/g
const LITERAL_PATTERN = /"([a-z][a-z0-9]{1,7}_[a-z0-9_]{2,})"/g
const SANDBOX_PATTERN = /\b(System\.IO|System\.Net|System\.Threading|Thread\.Sleep|HttpClient|WebClient|File\.|Directory\.)\b/
const ASSEMBLY_NAME_PATTERN = /<AssemblyName>\s*([^<\s]+)\s*<\/AssemblyName>/
const ASSEMBLY_VERSION_PATTERN = /<Assembly(?:Informational)?Version>\s*([^<\s]+)\s*<\//
const REFERENCE_PATTERN = /<Reference\s+Include="([^",]+)/
const SECURE_CONFIG_PATTERN = /\b(secureConfig|unsecureConfig|SecureConfig|UnsecureConfig)\b/
const CTOR_PATTERN = /(?:public|internal)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?::\s*base\([^)]*\))?\s*\{/g

/**
 * Read the facts we need out of the added lines of a diff.
 * @param lines - `[{ line, text }]` as produced by `parseDiff`.
 */
export function extractCsharpFacts(lines) {
  const classes = []
  const images = []
  const literals = new Map()
  const sandbox = []
  const references = []
  let assemblyName = null
  let assemblyVersion = null
  let secureConfig = false

  for (const { line, text } of lines) {
    const classMatch = CLASS_PATTERN.exec(text)
    if (classMatch) {
      const bases = String(classMatch[2] ?? '').split(',').map((item) => item.trim())
      classes.push({ name: classMatch[1], plugin: bases.some((item) => item.endsWith('IPlugin')), line })
    }

    IMAGE_PATTERN.lastIndex = 0
    let imageMatch
    while ((imageMatch = IMAGE_PATTERN.exec(text))) {
      images.push({ kind: imageMatch[1] === 'Pre' ? 'pre' : 'post', name: imageMatch[2], line })
    }

    LITERAL_PATTERN.lastIndex = 0
    let literalMatch
    while ((literalMatch = LITERAL_PATTERN.exec(text))) {
      if (!literals.has(literalMatch[1])) literals.set(literalMatch[1], line)
    }

    const sandboxMatch = SANDBOX_PATTERN.exec(text)
    if (sandboxMatch) sandbox.push({ api: sandboxMatch[1], line })

    const nameMatch = ASSEMBLY_NAME_PATTERN.exec(text)
    if (nameMatch) assemblyName = nameMatch[1]
    const versionMatch = ASSEMBLY_VERSION_PATTERN.exec(text)
    if (versionMatch) assemblyVersion = versionMatch[1]

    const refMatch = REFERENCE_PATTERN.exec(text)
    if (refMatch) references.push({ name: refMatch[1], line })

    if (SECURE_CONFIG_PATTERN.test(text)) secureConfig = true
  }

  CTOR_PATTERN.lastIndex = 0
  let ctor
  const text = lines.map((item) => item.text).join('\n')
  while ((ctor = CTOR_PATTERN.exec(text))) {
    const params = ctor[2]
    const strings = params.match(/\bstring\b/g)?.length ?? 0
    if (strings >= 2) secureConfig = true
  }

  return {
    classes,
    images: dedupe(images, (item) => `${item.kind}:${item.name}`),
    literals: [...literals.entries()].map(([value, line]) => ({ value, line })),
    sandbox,
    references,
    assemblyName,
    assemblyVersion,
    secureConfig,
  }
}

function dedupe(items, keyOf) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const key = keyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * Guess the assembly a file belongs to: explicit `<AssemblyName>`, then the
 * innermost dotted folder above the file (that is the project folder in this
 * repository), then nothing.
 */
export function guessAssembly(path, facts) {
  if (facts.assemblyName) return { name: facts.assemblyName.replace(/\.dll$/i, ''), source: 'csproj' }
  const segments = String(path ?? '').split('/').slice(0, -1)
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]
    if (/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(segment)) {
      return { name: segment, source: 'path' }
    }
  }
  return { name: null, source: 'none' }
}

async function listAssemblies(client, signal) {
  return readAll(client, 'pluginassemblies', {
    $select: 'pluginassemblyid,name,version,isolationmode,ismanaged',
  }, 500, signal)
}

function matchAssembly(assemblies, name) {
  const wanted = String(name).toLowerCase().replace(/\.dll$/, '')
  const exact = assemblies.find((item) => String(item.name).toLowerCase().replace(/\.dll$/, '') === wanted)
  if (exact) return { assembly: exact, certain: true, candidates: [exact.name] }
  const similar = assemblies
    .filter((item) => {
      const current = String(item.name).toLowerCase().replace(/\.dll$/, '')
      return current.includes(wanted.slice(-12)) || wanted.includes(current.slice(-12))
    })
    .map((item) => item.name)
  // One near miss is worth checking against; several are a coin flip, and a
  // wrong guess would validate the wrong types and steps. Report those for a
  // human instead of silently picking one.
  if (similar.length === 1) {
    const only = assemblies.find((item) => item.name === similar[0]) ?? null
    return { assembly: only, certain: false, candidates: similar }
  }
  return { assembly: null, certain: false, candidates: similar }
}

async function listTypes(client, assemblyId, signal) {
  return readAll(client, 'plugintypes', {
    $select: 'plugintypeid,typename,friendlyname,_pluginassemblyid_value',
    $filter: `_pluginassemblyid_value eq ${assemblyId}`,
  }, 500, signal)
}

async function listSteps(client, typeId, signal) {
  // `primaryobjecttypecode` lives on the message filter, not on the step, so
  // expand through `sdkmessagefilterid`; fall back to a plain read when the
  // environment rejects the expand. The fallback keeps the lookup columns: with
  // them every step still knows which message and which filter it belongs to,
  // without them all steps looked like the same message on the same stage.
  const select = 'sdkmessageprocessingstepid,name,stage,mode,rank,filteringattributes,statecode,_sdkmessagefilterid_value,_sdkmessageid_value'
  try {
    return await readAll(client, 'sdkmessageprocessingsteps', {
      $select: select,
      $expand: 'sdkmessagefilterid($select=primaryobjecttypecode),sdkmessageid($select=name)',
      $filter: `_eventhandler_value eq ${typeId}`,
    }, 200, signal)
  } catch (error) {
    if (error?.status !== 400) throw error
    return readAll(client, 'sdkmessageprocessingsteps', {
      $select: select,
      $filter: `_eventhandler_value eq ${typeId}`,
    }, 200, signal)
  }
}

/** Message name of a step, falling back to the lookup id when the expand failed. */
function stepMessage(step) {
  return String(step.sdkmessageid?.name ?? step._sdkmessageid_value ?? '').toLowerCase()
}

/** Table a step's message filter targets, when the expand provided it. */
function stepEntity(step) {
  const value = String(step.sdkmessagefilterid?.primaryobjecttypecode ?? step.primaryobjecttypecode ?? '')
    .trim()
    .toLowerCase()
  return value && value !== 'none' ? value : ''
}

/** Identity of a step's message filter: the table, else the lookup id. */
function stepFilterKey(step) {
  return stepEntity(step) || String(step._sdkmessagefilterid_value ?? '').toLowerCase()
}

async function listImages(client, stepId, signal) {
  return readAll(client, 'sdkmessageprocessingstepimages', {
    $select: 'name,imagetype,attributes',
    $filter: `_sdkmessageprocessingstepid_value eq ${stepId}`,
  }, 50, signal)
}

/**
 * Does `entity.attribute` exist?
 *
 * A failed read (403, timeout, throttling) is not an absence: caching it as
 * `false` turned a permission problem into a "field missing" blocker. A definite
 * 404, or an empty result, is the only evidence for "absent".
 * @returns `'present' | 'absent' | 'unknown'`
 */
async function attributeExists(client, entity, attribute, signal, cache) {
  const key = `${entity}.${attribute}`.toLowerCase()
  if (cache.has(key)) return cache.get(key)
  let state = 'unknown'
  try {
    const result = await getPagedWithSelectFallback(client, `EntityDefinitions(LogicalName='${odataString(entity)}')/Attributes`, {
      $select: 'LogicalName',
      $filter: `LogicalName eq '${odataString(attribute)}'`,
    }, 1, signal)
    state = (result?.page?.records?.length ?? 0) > 0 ? 'present' : 'absent'
  } catch (error) {
    state = error?.status === 404 ? 'absent' : 'unknown'
  }
  cache.set(key, state)
  return state
}

async function entityNames(client, signal) {
  const result = await getPagedWithSelectFallback(client, 'EntityDefinitions', {
    // Definition collections reject $top (0x80060888), so skip straight to the
    // paging form instead of paying for a rejected request first.
    __noTop: true,
    $select: 'LogicalName',
  }, 5000, signal)
  return new Set((result?.page?.records ?? []).map((row) => String(row.LogicalName).toLowerCase()))
}

/**
 * Check one changed C# file against every target environment.
 * @returns `{ file, findings, human }` — callers merge these into the report.
 */
export async function analyzeCsharpFile({ change, config, targetKeys, signal, askHuman }) {
  const facts = extractCsharpFacts(change.added ?? [])
  const file = {
    path: change.newPath,
    kind: 'csharp',
    addedLines: change.added?.length ?? 0,
    removedLines: change.removed?.length ?? 0,
    facts: {
      classes: facts.classes.map((item) => item.name),
      images: facts.images.map((item) => `${item.kind}:${item.name}`),
      literals: facts.literals.map((item) => item.value),
      assemblyVersion: facts.assemblyVersion,
    },
    targets: [],
  }
  const findings = []

  const isBuildFile = /\.(csproj|projitems|csproj\.user)$/i.test(change.newPath)
  if (isBuildFile) {
    for (const reference of facts.references.slice(0, 10)) {
      findings.push({
        severity: 'warning',
        target: targetKeys[0] ?? '—',
        file: change.newPath,
        line: reference.line,
        message: t('csharp.externalReference',{name:reference.name}),
      })
    }
    file.note = t('csharp.buildFileNote')
    return { file, findings }
  }

  const guess = guessAssembly(change.newPath, facts)
  if (!guess.name) {
    askHuman({
      object: change.newPath,
      question: t('csharp.assemblyQuestion'),
      evidence: t('csharp.assemblyEvidence'),
      howToCheck: t('csharp.assemblyHow'),
      impact: t('csharp.assemblyImpact'),
    })
    return { file, findings }
  }

  for (const targetKey of targetKeys) {
    const env = config.environments[targetKey]
    const client = new DataverseClient(env, { timeoutMs: config.timeoutMs })
    const targetReport = { target: targetKey, assembly: null, version: null, certain: false, candidates: [], types: [] }
    try {
      const assemblies = await listAssemblies(client, signal)
      const matched = matchAssembly(assemblies, guess.name)
      if (!matched.assembly) {
        findings.push({
          severity: 'warning',
          target: targetKey,
          file: change.newPath,
          line: null,
          message: matched.candidates.length
            ? t('csharp.assemblyMissingSimilar', { name: guess.name, candidates: matched.candidates.join(', ') })
            : t('csharp.assemblyMissing', { name: guess.name }),
        })
        askHuman({
          object: change.newPath,
          question: t('csharp.finalAssemblyQuestion',{env:targetKey,name:guess.name}),
          evidence: t('csharp.finalAssemblyEvidence',{name:guess.name,candidates:matched.candidates.length?t('csharp.similarAssemblies',{values:matched.candidates.join(', ')}):t('csharp.noSimilarAssembly')}),
          howToCheck: t('csharp.finalAssemblyHow'),
          impact: t('csharp.assemblyImpact'),
        })
        file.targets.push(targetReport)
        continue
      }
      if (!matched.certain) {
        askHuman({
          object: change.newPath,
          question: t('csharp.ambiguousAssembly',{name:matched.assembly.name,candidates:matched.candidates.join(', ')}),
          evidence: t('csharp.ambiguousAssemblyEvidence'),
          howToCheck: t('csharp.ambiguousAssemblyHow'),
          impact: t('csharp.ambiguousAssemblyImpact'),
        })
      }

      targetReport.assembly = matched.assembly.name
      targetReport.version = matched.assembly.version ?? null
      targetReport.certain = matched.certain
      targetReport.candidates = matched.candidates

      const compilerVersion = facts.assemblyVersion
      // Versions are dotted numbers, not strings: 1.0.0 and 1.0.0.0 are the same
      // build, while 1.0.10 is newer than 1.0.9.
      if (compilerVersion && matched.assembly.version
        && compareVersion(compilerVersion, matched.assembly.version) !== 0) {
        findings.push({
          severity: 'warning',
          target: targetKey,
          file: change.newPath,
          line: null,
          message: t('csharp.versionMismatch',{compiler:compilerVersion,environment:matched.assembly.version}),
        })
      }

      const types = await listTypes(client, matched.assembly.pluginassemblyid, signal)
      const typeIndex = new Map(types.map((type) => [String(type.typename).toLowerCase(), type]))
      const classNames = facts.classes.filter((item) => item.plugin).map((item) => item.name)
      const basename = change.newPath.split('/').pop().replace(/\.cs$/i, '')
      let classGuess = 'declared'
      if (!classNames.length && /Plugin$/.test(basename)) {
        // The class declaration itself is rarely inside a diff (only a method
        // body changed). The file name is a guess: a wrong guess validates the
        // steps of the wrong type, so it is reported instead of trusted.
        classNames.push(basename)
        classGuess = 'basename'
      }
      if (!classNames.length) {
        askHuman({
          object: change.newPath,
          question: t('csharp.classQuestion'),
          evidence: t('csharp.classEvidence'),
          howToCheck: t('csharp.classHow'),
          impact: t('csharp.classImpact'),
        })
      } else if (classGuess === 'basename') {
        findings.push({
          severity: 'warning',
          target: targetKey,
          file: change.newPath,
          line: null,
          message: t('csharp.classGuess',{name:basename}),
        })
      }

      const attributeCache = new Map()
      let entities = null

      for (const className of dedupe(classNames.map((name) => ({ name })), (item) => item.name)) {
        const match = types.find((type) => {
          const typename = String(type.typename).toLowerCase()
          return typename === className.name.toLowerCase() || typename.endsWith(`.${className.name.toLowerCase()}`)
        })
        const typeEntry = { name: className.name, exists: Boolean(match), steps: [] }
        targetReport.types.push(typeEntry)

        if (!match) {
          findings.push({
            severity: 'blocker',
            target: targetKey,
            file: change.newPath,
            line: null,
            message: t('csharp.typeMissing',{name:className.name}),
          })
          continue
        }

        const steps = await listSteps(client, match.plugintypeid, signal)
        if (!steps.length) {
          findings.push({
            severity: 'warning',
            target: targetKey,
            file: change.newPath,
            line: null,
            message: t('csharp.noSteps',{name:className.name}),
          })
        }

        // Two steps on the same message+stage+table run in rank order; when ranks
        // are equal (or both default) the order is not something to rely on. The
        // table belongs in the key: the same message and stage on two different
        // tables are independent registrations.
        const stageGroups = new Map()
        for (const step of steps) {
          const key = `${stepMessage(step)}|${step.stage}|${stepFilterKey(step)}`
          if (!stageGroups.has(key)) stageGroups.set(key, [])
          stageGroups.get(key).push(step)
        }
        for (const [key, group] of stageGroups) {
          if (group.length < 2) continue
          const ranks = group.map((step) => Number(step.rank ?? 0))
          const duplicated = new Set(ranks).size !== ranks.length
          const [message, stage] = key.split('|')
          // Without the expand the key carries lookup ids: say so instead of
          // printing a GUID as if it were the message name.
          const named = message && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(message)
          const table = stepEntity(group[0]) ? ` / ${stepEntity(group[0])}` : ''
          findings.push({
            severity: 'warning',
            target: targetKey,
            file: change.newPath,
            line: null,
            message: t('csharp.duplicateSteps',{message:named?message:t('csharp.unknownMessage'),table,stage,count:group.length,ranks:ranks.join(', '),order:duplicated?t('csharp.rankDuplicate'):t('csharp.rankOrder')}),
          })
        }

        for (const step of steps.slice(0, 20)) {
          const images = await listImages(client, step.sdkmessageprocessingstepid, signal)
          typeEntry.steps.push({
            name: step.name,
            stage: step.stage,
            mode: step.mode,
            filteringAttributes: step.filteringattributes ?? '',
            images: images.map((image) => image.name),
          })

          const message = stepMessage(step)
          for (const wanted of facts.images) {
            // A Create step has no pre-image by definition; code that reads
            // PreEntityImages only on update is fine there.
            if (wanted.kind === 'pre' && message === 'create') continue
            const wantedType = wanted.kind === 'pre' ? 0 : 1
            const hit = images.some((image) => Number(image.imagetype) === wantedType
              && String(image.name).toLowerCase() === wanted.name.toLowerCase())
            if (hit) continue
            findings.push({
              severity: 'blocker',
              target: targetKey,
              file: change.newPath,
              line: wanted.line,
              message: t('csharp.imageMissing',{kind:wanted.kind==='pre'?'Pre':'Post',name:wanted.name,step:step.name}),
            })
          }

          const entity = stepEntity(step)
          const filtering = String(step.filteringattributes ?? '').split(',').map((item) => item.trim()).filter(Boolean)
          if (entity && filtering.length) {
            for (const attribute of filtering) {
              const state = await attributeExists(client, entity, attribute, signal, attributeCache)
              if (state === 'present') continue
              if (state === 'unknown') {
                // The read failed (permission, timeout): "we could not check" is
                // a human item, not "this field does not exist".
                askHuman({
                  object: `${entity}.${attribute}`,
                  question: t('csharp.filterQuestion',{entity,attribute,env:targetKey}),
                  evidence: t('csharp.filterEvidence',{step:step.name}),
                  howToCheck: t('csharp.filterHow'),
                  impact: t('csharp.filterImpact'),
                })
                continue
              }
              findings.push({
                severity: 'blocker',
                target: targetKey,
                file: change.newPath,
                line: null,
                message: t('csharp.filterMissing',{step:step.name,attribute,entity}),
              })
            }
          }
        }
      }

      // Metadata literals in code (entity / field / global option set names).
      const literals = facts.literals.slice(0, 25)
      if (literals.length) {
        if (!entities) entities = await entityNames(client, signal)
        const entityHints = literals
          .map((item) => item.value)
          .filter((value) => entities.has(value.toLowerCase()))
          .slice(0, 3)

        for (const literal of literals) {
          if (entities.has(literal.value.toLowerCase())) continue
          let fieldHit = false
          let readFailed = false
          for (const entity of entityHints) {
            const state = await attributeExists(client, entity, literal.value, signal, attributeCache)
            if (state === 'present') {
              fieldHit = true
              break
            }
            if (state === 'unknown') readFailed = true
          }
          if (fieldHit) {
            targetReport.types.push({ name: t('csharp.fieldLabel',{value:literal.value}), exists: true, steps: [] })
            continue
          }
          askHuman({
            object: literal.value,
            question: t('csharp.literalQuestion',{value:literal.value,env:targetKey}),
            evidence: t('csharp.literalEvidence',{line:literal.line,fieldHint:entityHints.length?t('csharp.literalFieldHint',{values:entityHints.join(', ')}):'',readFailed:readFailed?t('csharp.literalReadFailed'):''}),
            howToCheck: t('csharp.literalHow'),
            impact: t('csharp.literalImpact'),
          })
        }
      }

      if (facts.secureConfig) {
        askHuman({
          object: t('csharp.secureObject',{assembly:matched.assembly.name}),
          question: t('csharp.secureQuestion',{env:targetKey}),
          evidence: t('csharp.secureEvidence'),
          howToCheck: t('csharp.secureHow'),
          impact: t('csharp.secureImpact'),
        })
      }

      for (const sandbox of facts.sandbox.slice(0, 5)) {
        findings.push({
          severity: 'warning',
          target: targetKey,
          file: change.newPath,
          line: sandbox.line,
          message: t('csharp.sandboxApi',{api:sandbox.api}),
        })
      }
      for (const reference of facts.references.slice(0, 10)) {
        findings.push({
          severity: 'warning',
          target: targetKey,
          file: change.newPath,
          line: reference.line,
          message: t('csharp.externalReference',{name:reference.name}),
        })
      }
    } catch (error) {
      findings.push({
        severity: 'warning',
        target: targetKey,
        file: change.newPath,
        line: null,
        message: t('csharp.checkFailed',{message:error.message}),
      })
    }
    file.targets.push(targetReport)
  }

  return { file, findings }
}
