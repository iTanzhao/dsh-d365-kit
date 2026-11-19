/**
 * Reverse index: who references this thing?
 *
 * Metadata tells you what exists; it does not tell you what would break if you
 * remove or rename it. The references live in text blobs that Dataverse stores
 * alongside the definitions — formxml, layoutxml/fetchxml, workflow xaml — so
 * this module reads those blobs and asks "does the exact reference appear?".
 *
 * Only exact, quoted matches count. A substring search for `name` would match
 * `fullname`, so every pattern ends at a quote or a tag boundary.
 */
import { D365Error } from './errors.js'
import { odataString } from './resources.js'
import { t } from './i18n.js'

/** Form types, for labelling what a form is. */
const FORM_TYPES = { 2: () => t('refs.form.main'), 5: () => t('refs.form.quickView'), 6: () => t('refs.form.quickCreate'), 7: () => t('refs.form.card') }

/** Workflow categories. */
const WORKFLOW_CATEGORIES = { 0: () => t('refs.workflow.workflow'), 1: () => t('refs.workflow.dialog'), 2: () => t('refs.workflow.rule'), 3: () => t('refs.workflow.action'), 4: () => t('refs.workflow.process'), 5: () => t('refs.workflow.modernFlow'), 6: () => t('refs.workflow.desktopFlow') }

/** Query a collection, tolerating servers that reject `$select` on the path. */
export async function readAll(client, path, params, limit, signal) {
  const page = await client.getPaged(path, params, limit, signal)
  return page.records ?? []
}

/**
 * Find forms that touch a field.
 * @param entity - entity logical name.
 * @param attribute - attribute logical name.
 * @returns forms with the attribute on them.
 */
export async function findFieldForms(client, entity, attribute, signal) {
  const needle = `datafieldname="${attribute}"`
  const filter = `objecttypecode eq '${entity}' and contains(formxml,'${odataString(needle)}')`
  const rows = await readAll(client, 'systemforms', {
    $select: 'name,type,objecttypecode,formxml,ismanaged',
    $filter: filter,
  }, 200, signal)
  return rows.map((row) => {
    // Each control carries its own `visible` attribute, so the control tag — not
    // the whole form — is the unit that decides whether the field shows.
    const controls = String(row.formxml ?? '').match(/<control\b[^>]*>/gi) ?? []
    const own = controls.filter((tag) => tag.includes(`datafieldname="${attribute}"`))
    return {
      name: row.name,
      type: row.type,
      typeLabel: FORM_TYPES[row.type]?.() ?? t('refs.typeUnknown',{type:row.type}),
      managed: row.ismanaged,
      visible: own.some((tag) => !/\bvisible="false"/i.test(tag)),
    }
  })
}

/**
 * Find views whose layout or filter mentions a field.
 * @returns views that would break (layout) or change behaviour (filter).
 */
export async function findFieldViews(client, entity, attribute, signal) {
  const inLayout = `contains(layoutxml,'${odataString(`name="${attribute}"`)}')`
  const inFilter = `contains(fetchxml,'${odataString(`attribute="${attribute}"`)}')`
  const rows = await readAll(client, 'savedqueries', {
    $select: 'name,querytype,returnedtypecode,isdefault,layoutxml,fetchxml',
    $filter: `returnedtypecode eq '${entity}' and (${inLayout} or ${inFilter})`,
  }, 500, signal)
  return rows.map((row) => ({
    name: row.name,
    queryType: row.querytype,
    default: row.isdefault,
    inLayout: String(row.layoutxml ?? '').includes(`name="${attribute}"`),
    inFilter: String(row.fetchxml ?? '').includes(`attribute="${attribute}"`),
  }))
}

/**
 * Find workflows and business rules whose definition mentions a field.
 *
 * The definition lives in `clientdata` (a large string). Asking the server to
 * filter on it is not portable, so this pulls the entity's automations and
 * scans locally; that is bounded by the number of automations on one entity.
 * @returns automations that mention the field.
 */
export async function findFieldAutomations(client, entity, attribute, signal) {
  const rows = await readAll(client, 'workflows', {
    $select: 'name,category,statecode,primaryentity,clientdata',
    $filter: `primaryentity eq '${entity}'`,
  }, 1000, signal)
  const quoted = `["']${attribute}["']`
  const patterns = [
    new RegExp(`<AttributeName>${attribute}</AttributeName>`, 'i'),
    new RegExp(`"attributeName"\\s*:\\s*"${attribute}"`, 'i'),
    new RegExp(`getAttribute\\(\\s*${quoted}`, 'i'),
    // Business rules compile to `formContext.data.entity.attributes.get('x')`.
    new RegExp(`attributes\\.get\\(\\s*${quoted}`, 'i'),
    new RegExp(`attributes\\[\\s*${quoted}\\s*\\]`, 'i'),
  ]
  return rows
    .filter((row) => patterns.some((pattern) => pattern.test(String(row.clientdata ?? ''))))
    .map((row) => ({
      name: row.name,
      category: WORKFLOW_CATEGORIES[row.category]?.() ?? t('refs.categoryUnknown',{category:row.category}),
      state: row.statecode === 1 ? t('refs.state.active') : t('refs.state.inactive'),
    }))
}

/**
 * Find forms whose scripts reference a web resource.
 * @param resourceName - web resource name as written in formxml `libraryName`.
 */
export async function findResourceForms(client, resourceName, signal) {
  const rows = await readAll(client, 'systemforms', {
    $select: 'name,type,objecttypecode,formxml',
    $filter: `contains(formxml,'${odataString(`libraryName="${resourceName}"`)}')`,
  }, 500, signal)
  return rows.map((row) => {
    // The event name lives on the enclosing <event> node; the <Handler> only
    // names the function. Pair them so the report says "onload → fn" instead of
    // "? → fn".
    const handlers = []
    for (const block of String(row.formxml ?? '').matchAll(/<event\b[^>]*>([\s\S]*?)<\/event>/gi)) {
      const eventTag = block[0].slice(0, block[0].indexOf('>') + 1)
      const eventName = /\bname="([^"]*)"/i.exec(eventTag)?.[1] ?? ''
      for (const match of block[1].matchAll(/<Handler\b[^>]*>/gi)) {
        const tag = match[0]
        if (!tag.includes(`libraryName="${resourceName}"`)) continue
        const fn = /functionName="([^"]*)"/i.exec(tag)
        handlers.push({ functionName: fn?.[1] ?? '', event: eventName })
      }
    }
    return {
      name: row.name,
      type: row.type,
      typeLabel: FORM_TYPES[row.type]?.() ?? t('refs.typeUnknown',{type:row.type}),
      entity: row.objecttypecode,
      handlers,
    }
  })
}

/**
 * Resolve a plugin assembly name to its types and message steps.
 * @returns `{ assembly, types: [{ typename, steps: [...] }] }`
 */
export async function findPluginUsage(client, assemblyName, signal) {
  const assemblies = await readAll(client, 'pluginassemblies', {
    $select: 'pluginassemblyid,name,version,isolationmode,sourcetype',
    $filter: `name eq '${odataString(assemblyName)}'`,
  }, 5, signal)
  const assembly = assemblies[0]
  if (!assembly) {
    throw new D365Error(t('refs.assemblyMissing',{name:assemblyName}), {
      code: 'unknown-assembly',
      hint: t('refs.assemblyMissingHint'),
    })
  }

  const types = await readAll(client, 'plugintypes', {
    $select: 'plugintypeid,typename,friendlyname,_pluginassemblyid_value',
    $filter: `_pluginassemblyid_value eq ${assembly.pluginassemblyid}`,
  }, 200, signal)

  const detail = []
  for (const type of types) {
    const steps = await readAll(client, 'sdkmessageprocessingsteps', {
      $select: 'name,stage,mode,rank,filteringattributes,statecode,configuration',
      $filter: `_eventhandler_value eq ${type.plugintypeid}`,
    }, 100, signal)
    detail.push({
      typename: type.typename,
      friendlyName: type.friendlyname,
      steps: steps.map((step) => ({
        name: step.name,
        stage: step.stage,
        mode: step.mode,
        rank: step.rank,
        filteringAttributes: step.filteringattributes,
        enabled: step.statecode === 0,
      })),
    })
  }

  return {
    assembly: {
      name: assembly.name,
      version: assembly.version,
      isolation: assembly.isolationmode,
      source: assembly.sourcetype,
    },
    types: detail,
  }
}
