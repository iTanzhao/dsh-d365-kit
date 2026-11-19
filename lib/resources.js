/**
 * The metadata resource catalogue.
 *
 * Each entry turns model-facing arguments into one Web API collection request.
 * `$select` lists are deliberately minimal-but-useful: a wrong property name
 * fails the whole query with 400, and the client has a fallback that retries
 * without `$select` rather than losing the call entirely.
 */

/** Escape a value for an OData string literal (double the single quote). */
export const odataString = (value) => String(value).replace(/'/g, "''")

/** Entity-scoped resources need `entity`; the tool reports this before calling. */
const entityFilter = {
  forms: (entity) => `objecttypecode eq '${odataString(entity)}'`,
  views: (entity) => `returnedtypecode eq '${odataString(entity)}'`,
  workflows: (entity) => `primaryentity eq '${odataString(entity)}'`,
  business_rules: (entity) => `primaryentity eq '${odataString(entity)}'`,
  attributes: null,
  keys: null,
  one_to_many_relationships: null,
  many_to_many_relationships: null,
}

export const RESOURCES = {
  organization: {
    summary: 'Organization details exposed by the environment; RetrieveVersion supplies the version separately',
    path: () => 'organizations',
    // No $select on purpose: deployments differ in which organization
    // properties exist, and naming a missing one fails the whole query.
  },

  entities: {
    summary: 'All table definitions: logical, schema and collection names, and customization state',
    path: () => 'EntityDefinitions',
    select: 'LogicalName,SchemaName,EntitySetName,ObjectTypeCode,IsCustomEntity,IsManaged,PrimaryIdAttribute,PrimaryNameAttribute',
    // No $orderby: the metadata endpoint rejects it (`$orderby` returns
    // 0x80060888 "The query parameter ... is not supported").
  },

  attributes: {
    summary: 'All attribute definitions for one table',
    entityScoped: true,
    path: (args) => `EntityDefinitions(LogicalName='${odataString(args.entity)}')/Attributes`,
    select: 'LogicalName,SchemaName,AttributeType,AttributeTypeName,IsCustomAttribute,RequiredLevel,IsPrimaryId,IsValidForCreate,IsValidForUpdate,IsValidForRead',
    // Typed columns (DefaultValue, OptionSet, Targets, Format ...) only exist on
    // the derived metadata type, so reading one of them means casting the keyed
    // attribute to e.g. Microsoft.Dynamics.CRM.BooleanAttributeMetadata.
    keyedByAttribute: (args) => `EntityDefinitions(LogicalName='${odataString(args.entity)}')/Attributes(LogicalName='${odataString(args.attribute)}')${args.cast ? `/Microsoft.Dynamics.CRM.${args.cast}` : ''}`,
    defaultTop: 1000,
  },

  keys: {
    summary: 'Alternate-key definitions for one table',
    entityScoped: true,
    path: (args) => `EntityDefinitions(LogicalName='${odataString(args.entity)}')/Keys`,
  },

  one_to_many_relationships: {
    summary: 'One-to-many relationships for one table',
    entityScoped: true,
    path: (args) => `EntityDefinitions(LogicalName='${odataString(args.entity)}')/OneToManyRelationships`,
  },

  many_to_many_relationships: {
    summary: 'Many-to-many relationships for one table',
    entityScoped: true,
    path: (args) => `EntityDefinitions(LogicalName='${odataString(args.entity)}')/ManyToManyRelationships`,
  },

  forms: {
    summary: 'System-form definitions; use select to request formxml',
    entityFilter: entityFilter.forms,
    path: () => 'systemforms',
    select: 'formid,name,type,objecttypecode,description,ismanaged,modifiedon',
    orderby: 'name asc',
  },

  views: {
    summary: 'Saved-query views: name, type and default status',
    entityFilter: entityFilter.views,
    path: () => 'savedqueries',
    select: 'savedqueryid,name,querytype,returnedtypecode,isdefault,ismanaged,modifiedon',
    orderby: 'name asc',
  },

  workflows: {
    summary: 'Workflows and processes, including business rules distinguished by category',
    entityFilter: entityFilter.workflows,
    path: () => 'workflows',
    // Dataverse stores every process twice: a definition row (type 1) and an
    // activation row (type 2) with its own workflowid and the same name.
    // Listing both makes each process look duplicated and doubles the count,
    // so the definition row is the default. Pass `filter` to see activation
    // rows instead (e.g. "type eq 2") — an explicit filter replaces this one.
    defaultFilter: 'type eq 1',
    select: 'workflowid,name,category,type,statecode,statuscode,primaryentity,createdon,modifiedon',
    orderby: 'name asc',
  },

  business_rules: {
    summary: 'Business rules: the category=2 subset of workflows',
    entityFilter: entityFilter.business_rules,
    path: () => 'workflows',
    filter: 'category eq 2',
    defaultFilter: 'type eq 1',
    select: 'workflowid,name,category,type,statecode,statuscode,primaryentity,modifiedon',
    orderby: 'name asc',
  },

  plugin_assemblies: {
    summary: 'Plug-in assemblies: name, version and deployment mode',
    path: () => 'pluginassemblies',
    select: 'pluginassemblyid,name,version,culture,publickeytoken,isolationmode,sourcetype,ismanaged',
    orderby: 'name asc',
  },

  plugin_types: {
    summary: 'Plug-in types: full class name and containing assembly',
    path: () => 'plugintypes',
    select: 'plugintypeid,typename,pluginassemblyid,isworkflowactivity,friendlyname',
    defaultTop: 1000,
    orderby: 'typename asc',
  },

  plugin_steps: {
    summary: 'SDK message-processing steps: message, stage, mode and filtering attributes',
    path: () => 'sdkmessageprocessingsteps',
    select: 'sdkmessageprocessingstepid,name,stage,mode,rank,statecode,filteringattributes,configuration,plugintypeid,sdkmessageid',
    // 5000+ steps is normal on a mature organization, and the default of 200
    // sorted by name means the step being looked for is usually not in the page.
    defaultTop: 1000,
    expand: 'plugintypeid($select=typename),sdkmessageid($select=name)',
    orderby: 'name asc',
  },

  step_images: {
    summary: 'Step images: image type, alias and participating attributes',
    path: () => 'sdkmessageprocessingstepimages',
    select: 'sdkmessageprocessingstepimageid,name,imagetype,messagepropertyname,entityalias,attributes,ismanaged,sdkmessageprocessingstepid',
    defaultTop: 1000,
    orderby: 'name asc',
  },

  web_resources: {
    summary: 'Web-resource catalog; content is omitted by default',
    path: () => 'webresourceset',
    select: 'webresourceid,name,displayname,webresourcetype,ismanaged,modifiedon',
    orderby: 'name asc',
  },

  solutions: {
    summary: 'Solution catalog: unique name, version, managed state and install time',
    path: () => 'solutions',
    select: 'solutionid,uniquename,friendlyname,version,ismanaged,installedon,isvisible,publisherid',
    orderby: 'uniquename asc',
  },

  solution_components: {
    summary: 'Solution components: the solution membership of each component',
    path: () => 'solutioncomponents',
    // Lookup columns come back as `_solutionid_value`, not `solutionid`.
    select: 'solutioncomponentid,componenttype,objectid,_solutionid_value,rootcomponentbehavior',
  },

  custom_apis: {
    summary: 'Custom API definitions',
    path: () => 'customapis',
    select: 'customapiid,uniquename,name,displayname,boundentitylogicalname,isfunction,isprivate',
    orderby: 'uniquename asc',
  },

  sitemaps: {
    summary: 'Sitemap definitions; sitemapxml is omitted by default',
    path: () => 'sitemaps',
    select: 'sitemapid,sitemapname,componentstate,ismanaged',
  },

  option_sets: {
    summary: 'Global option-set definitions',
    path: () => 'GlobalOptionSetDefinitions',
    select: 'Name,DisplayName,IsCustomOptionSet,OptionSetType,IsGlobal',
    // The option-set endpoint is a metadata collection: it rejects $filter
    // outright (HTTP 405, "The query parameter $filter is not supported") and
    // has no record id to page through, so a name is resolved with a keyed read
    // instead — one request instead of pulling all 987 definitions.
    filterable: false,
    keyedByName: (name) => `GlobalOptionSetDefinitions(Name='${odataString(name)}')`,
  },
}

/** Model-facing enum of resource keys. */
export const RESOURCE_KEYS = Object.keys(RESOURCES)

/**
 * Property that identifies a row of each resource. Used to align rows across
 * environments and to give a stable, human-recognisable label in summaries.
 */
export const KEY_FIELDS = {
  organization: 'organizationid',
  entities: 'LogicalName',
  attributes: 'LogicalName',
  keys: 'SchemaName',
  one_to_many_relationships: 'SchemaName',
  many_to_many_relationships: 'SchemaName',
  // Rows are only unique within a table: two tables both have a form called
  // "Information" and a view called "Active Accounts", so the owning entity is
  // part of the identity (the columns below are in each resource's `$select`).
  forms: ['name', 'objecttypecode'],
  views: ['name', 'returnedtypecode'],
  workflows: ['name', 'category', 'primaryentity'],
  business_rules: ['name', 'category', 'primaryentity'],
  plugin_assemblies: 'name',
  plugin_types: 'typename',
  plugin_steps: 'name',
  step_images: 'name',
  web_resources: 'name',
  solutions: 'uniquename',
  solution_components: ['_solutionid_value', 'componenttype', 'objectid'],
  custom_apis: 'uniquename',
  sitemaps: 'sitemapname',
  option_sets: 'Name',
}

/**
 * Properties worth showing in a cross-environment comparison, on top of
 * presence. Empty means "presence is the whole story".
 */
export const COMPARE_FIELDS = {
  solutions: ['version', 'ismanaged'],
  plugin_assemblies: ['version'],
  entities: ['IsCustomEntity', 'EntitySetName'],
  attributes: ['AttributeType', 'IsCustomAttribute'],
}

/** Best-effort identity for a row without knowing the resource. */
export function rowKey(resource, row, fields) {
  const spec = fields ?? KEY_FIELDS[resource]
  const list = Array.isArray(spec) ? spec : spec ? [spec] : []
  if (list.length) {
    const values = list.map((field) => {
      if (row?.[field] !== undefined && row?.[field] !== null && row[field] !== '') return row[field]
      // Lookup columns arrive as `_solutionid_value`; older snapshots stored the
      // bare name, so accept either spelling for the same key.
      const annotated = field.startsWith('_') ? field.replace(/^_/, '').replace(/_value$/, '') : `_${field}_value`
      return row?.[annotated]
    })
    if (values.every((value) => value !== undefined && value !== null && value !== '')) {
      return values.join('|')
    }
  }
  return row?.name ?? row?.Name ?? row?.logicalname ?? row?.['@odata.id'] ?? JSON.stringify(row).slice(0, 60)
}

/**
 * Index rows by identity key without dropping any.
 *
 * A key can still collide — e.g. two same-named workflows whose `primaryentity`
 * is empty — and `Map#set` would silently keep only the last row. A collision
 * appends `#2`, `#3`, ... in encounter order: deterministic for a stable row
 * order, and the same collision sequence on both sides keeps rows aligned.
 * @param resource - resource key, for the default key fields.
 * @param rows - rows to index.
 * @param fields - key field spec; defaults to the diff key then the display key.
 * @returns Map of key → row.
 */
export function keyedRows(resource, rows, fields) {
  const spec = fields ?? DIFF_KEY_FIELDS[resource] ?? KEY_FIELDS[resource]
  const map = new Map()
  const counts = new Map()
  for (const row of rows ?? []) {
    const base = rowKey(resource, row, spec)
    const count = (counts.get(base) ?? 0) + 1
    counts.set(base, count)
    map.set(count === 1 ? base : `${base}#${count}`, row)
  }
  return map
}

/**
 * Identity fields used when diffing snapshots. Attributes are only unique
 * within their entity, and a solution component is identified by the triple
 * (solution, type, object), not by `objectid` alone.
 */
export const DIFF_KEY_FIELDS = {
  attributes: ['entity', 'LogicalName'],
  solution_components: ['_solutionid_value', 'componenttype', 'objectid'],
}

/** Fields whose change is worth calling out first in a diff. */
export const HIGHLIGHT_FIELDS = {
  entities: ['EntitySetName', 'IsCustomEntity', 'IsManaged'],
  attributes: ['AttributeType', 'IsCustomAttribute', 'RequiredLevel'],
  forms: ['type', 'ismanaged'],
  views: ['querytype', 'isdefault'],
  workflows: ['category', 'statecode', 'statuscode'],
  plugin_assemblies: ['version'],
  plugin_steps: ['stage', 'mode', 'filteringattributes'],
  step_images: ['imagetype', 'attributes'],
  solutions: ['version', 'ismanaged'],
  web_resources: ['webresourcetype'],
  organization: ['version', 'organizationstructure'],
}

/**
 * Compose the final `$filter` from the resource's entity filter, its default
 * filter, and the caller's own expression.
 *
 * `defaultFilter` is a de-duplication guard (workflows are stored twice), so an
 * explicit `args.filter` replaces it rather than ANDing with it — otherwise
 * asking for "type eq 2" would compose into `type eq 1 and type eq 2`, i.e. an
 * empty result with no explanation.
 * @returns the filter string, or undefined.
 */
export function composeFilter(definition, args) {
  const parts = []
  if (definition.filter) parts.push(`(${definition.filter})`)
  if (definition.defaultFilter && !args.filter) parts.push(`(${definition.defaultFilter})`)
  if (definition.entityFilter && args.entity) parts.push(`(${definition.entityFilter(args.entity)})`)
  if (args.filter) parts.push(`(${args.filter})`)
  return parts.length ? parts.join(' and ') : undefined
}

/**
 * Collapse a Dataverse Label object into a plain string, preferring zh-CN then
 * the user's label then the first available. Recurses through arrays/objects
 * and drops `@odata.*` annotations.
 * @param value - any decoded JSON value.
 */
export function flattenLabels(value) {
  if (Array.isArray(value)) return value.map((item) => flattenLabels(item))
  if (value && typeof value === 'object') {
    if (Array.isArray(value.LocalizedLabels)) {
      const labels = value.LocalizedLabels
      const preferred = labels.find((item) => item?.LanguageCode === 2052)
        ?? labels.find((item) => item?.IsDefaultLanguage)
        ?? labels[0]
      return preferred?.Label ?? ''
    }
    const result = {}
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith('@odata.')) continue
      result[key] = flattenLabels(item)
    }
    return result
  }
  return value
}
