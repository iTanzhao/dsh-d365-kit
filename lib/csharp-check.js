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
  // environment rejects the expand.
  try {
    return await readAll(client, 'sdkmessageprocessingsteps', {
      $select: 'sdkmessageprocessingstepid,name,stage,mode,rank,filteringattributes,statecode,_sdkmessagefilterid_value,_sdkmessageid_value',
      $expand: 'sdkmessagefilterid($select=primaryobjecttypecode),sdkmessageid($select=name)',
      $filter: `_eventhandler_value eq ${typeId}`,
    }, 200, signal)
  } catch (error) {
    if (error?.status !== 400) throw error
    return readAll(client, 'sdkmessageprocessingsteps', {
      $select: 'sdkmessageprocessingstepid,name,stage,mode,rank,filteringattributes,statecode',
      $filter: `_eventhandler_value eq ${typeId}`,
    }, 200, signal)
  }
}

async function listImages(client, stepId, signal) {
  return readAll(client, 'sdkmessageprocessingstepimages', {
    $select: 'name,imagetype,attributes',
    $filter: `_sdkmessageprocessingstepid_value eq ${stepId}`,
  }, 50, signal)
}

async function attributeExists(client, entity, attribute, signal, cache) {
  const key = `${entity}.${attribute}`.toLowerCase()
  if (cache.has(key)) return cache.get(key)
  let exists = false
  try {
    const result = await getPagedWithSelectFallback(client, `EntityDefinitions(LogicalName='${odataString(entity)}')/Attributes`, {
      $select: 'LogicalName',
      $filter: `LogicalName eq '${odataString(attribute)}'`,
    }, 1, signal)
    exists = (result?.page?.records?.length ?? 0) > 0
  } catch {
    exists = false
  }
  cache.set(key, exists)
  return exists
}

async function entityNames(client, signal) {
  const result = await getPagedWithSelectFallback(client, 'EntityDefinitions', {
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
        message: `工程文件引用了外部程序集 ${reference.name}，确认它随程序集部署且被沙箱允许`,
      })
    }
    file.note = '工程文件，只做引用提示'
    return { file, findings }
  }

  const guess = guessAssembly(change.newPath, facts)
  if (!guess.name) {
    askHuman({
      object: change.newPath,
      question: '这个文件属于哪个插件程序集？',
      evidence: '路径里没有像程序集名的段落，文件里也没有 AssemblyName。',
      howToCheck: '看它所在 csproj 的 AssemblyName，或环境里 pluginassemblies 的名字。',
      impact: '映射不上就无法核对程序集版本、类型、步骤与镜像。',
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
            ? `目标环境没有名为 ${guess.name} 的程序集；相近的有 ${matched.candidates.join('、')}，需要确认文件属于哪一个`
            : `目标环境没有名为 ${guess.name} 的程序集，无法自动核对类型与步骤`,
        })
        askHuman({
          object: change.newPath,
          question: `这个文件最终打进哪个程序集？${targetKey} 里没有 ${guess.name}`,
          evidence: `按路径推断工程名 ${guess.name}${matched.candidates.length ? `，环境里相近的程序集：${matched.candidates.join('、')}` : '，环境里没有相近名字的程序集'}。`,
          howToCheck: '看它所属 csproj 的 AssemblyName，以及该工程被哪些插件程序集引用（共享工程不会单独部署）。',
          impact: '映射不上就核对不了程序集版本、类型、步骤与镜像。',
        })
        file.targets.push(targetReport)
        continue
      }
      if (!matched.certain) {
        askHuman({
          object: change.newPath,
          question: `这个文件属于 ${matched.assembly.name} 吗？候选：${matched.candidates.join('、')}`,
          evidence: '按路径推断的程序集名没有精确命中，按包含关系选了最接近的。',
          howToCheck: '核对 csproj 的 AssemblyName 与环境的插件程序集名。',
          impact: '映射错了，后面的类型/步骤核对对象就错了。',
        })
      }

      targetReport.assembly = matched.assembly.name
      targetReport.version = matched.assembly.version ?? null
      targetReport.certain = matched.certain
      targetReport.candidates = matched.candidates

      const compilerVersion = facts.assemblyVersion
      if (compilerVersion && matched.assembly.version && compilerVersion !== matched.assembly.version) {
        findings.push({
          severity: 'warning',
          target: targetKey,
          file: change.newPath,
          line: null,
          message: `源码里的版本 ${compilerVersion} 与环境里的程序集版本 ${matched.assembly.version} 不一致，入库的是否为编译产物需要确认`,
        })
      }

      const types = await listTypes(client, matched.assembly.pluginassemblyid, signal)
      const typeIndex = new Map(types.map((type) => [String(type.typename).toLowerCase(), type]))
      const classNames = facts.classes.filter((item) => item.plugin).map((item) => item.name)
      const basename = change.newPath.split('/').pop().replace(/\.cs$/i, '')
      if (!classNames.length && /Plugin$/.test(basename)) classNames.push(basename)

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
            message: `目标环境没有插件类型 ${className.name}，类改了但程序集里没有这个类型`,
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
            message: `插件类型 ${className.name} 在目标环境没有任何步骤，改动不会被触发`,
          })
        }

        // Two steps on the same message+stage run in rank order; when ranks are
        // equal (or both default) the order is not something to rely on.
        const stageGroups = new Map()
        for (const step of steps) {
          const message = String(step.sdkmessageid?.name ?? '').toLowerCase()
          const key = `${message}|${step.stage}`
          if (!stageGroups.has(key)) stageGroups.set(key, [])
          stageGroups.get(key).push(step)
        }
        for (const [key, group] of stageGroups) {
          if (group.length < 2) continue
          const ranks = group.map((step) => Number(step.rank ?? 0))
          const duplicated = new Set(ranks).size !== ranks.length
          const [message, stage] = key.split('|')
          findings.push({
            severity: 'warning',
            target: targetKey,
            file: change.newPath,
            line: null,
            message: `${message} / stage ${stage} 上有 ${group.length} 个步骤（rank ${ranks.join('、')}）${duplicated ? '，rank 重复时执行顺序不确定' : '，按 rank 从小到大的顺序执行'}`,
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

          const message = String(step.sdkmessageid?.name ?? '').toLowerCase()
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
              message: `代码读取了 ${wanted.kind === 'pre' ? 'Pre' : 'Post'}EntityImages["${wanted.name}"]，但步骤「${step.name}」没有注册同名镜像`,
            })
          }

          const entity = String(step.sdkmessagefilterid?.primaryobjecttypecode ?? step.primaryobjecttypecode ?? '')
          const filtering = String(step.filteringattributes ?? '').split(',').map((item) => item.trim()).filter(Boolean)
          if (entity && entity !== 'none' && filtering.length) {
            for (const attribute of filtering) {
              if (await attributeExists(client, entity, attribute, signal, attributeCache)) continue
              findings.push({
                severity: 'blocker',
                target: targetKey,
                file: change.newPath,
                line: null,
                message: `步骤「${step.name}」的过滤属性 ${attribute} 在表 ${entity} 上不存在，步骤不会按预期触发`,
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
          for (const entity of entityHints) {
            if (await attributeExists(client, entity, literal.value, signal, attributeCache)) {
              fieldHit = true
              break
            }
          }
          if (fieldHit) {
            targetReport.types.push({ name: `${literal.value}（字段）`, exists: true, steps: [] })
            continue
          }
          askHuman({
            object: literal.value,
            question: `确认 ${literal.value} 在 ${targetKey} 是否存在（表/字段/全局选项集）`,
            evidence: `代码第 ${literal.line} 行出现这个字面量；元数据里没有同名的表${entityHints.length ? `，在 ${entityHints.join('、')} 上也没有同名字段` : ''}。`,
            howToCheck: '确认它是字段、表还是全局选项集，再在目标环境核对；若属于别的表，需要在代码里看出所属实体。',
            impact: '名字拼错或目标环境没有该元数据时，插件运行到这一句会抛错或永远走不到。',
          })
        }
      }

      if (facts.secureConfig) {
        askHuman({
          object: `${matched.assembly.name} 的 secure configuration`,
          question: `确认 ${targetKey} 里该插件步骤的 secure configuration 已按这套代码配置`,
          evidence: '代码用到了 secure/unsecure 配置；Dataverse Web API 不返回 secureconfiguration 的内容，无法自动比对。',
          howToCheck: '在目标环境的插件注册工具里打开对应步骤，核对密钥版本与内容。',
          impact: '配置缺失或密钥版本不对时，解密会失败，而失败可能被吞掉（只写 tracing）。',
        })
      }

      for (const sandbox of facts.sandbox.slice(0, 5)) {
        findings.push({
          severity: 'warning',
          target: targetKey,
          file: change.newPath,
          line: sandbox.line,
          message: `代码用了 ${sandbox.api}，在沙箱隔离模式下可能被禁止`,
        })
      }
      for (const reference of facts.references.slice(0, 10)) {
        findings.push({
          severity: 'warning',
          target: targetKey,
          file: change.newPath,
          line: reference.line,
          message: `引用了外部程序集 ${reference.name}，确认它已随程序集部署且被沙箱允许`,
        })
      }
    } catch (error) {
      findings.push({
        severity: 'warning',
        target: targetKey,
        file: change.newPath,
        line: null,
        message: `C# 检查失败：${error.message}`,
      })
    }
    file.targets.push(targetReport)
  }

  return { file, findings }
}
