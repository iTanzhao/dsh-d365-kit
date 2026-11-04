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
    summary: '组织信息：返回该环境实际暴露的组织属性（各环境属性集不同），版本号另走 RetrieveVersion',
    path: () => 'organizations',
    // No $select on purpose: deployments differ in which organization
    // properties exist, and naming a missing one fails the whole query.
  },

  entities: {
    summary: '全部实体（表）定义：逻辑名、架构名、集合名、是否自定义',
    path: () => 'EntityDefinitions',
    select: 'LogicalName,SchemaName,EntitySetName,ObjectTypeCode,IsCustomEntity,IsManaged,PrimaryIdAttribute,PrimaryNameAttribute',
    // No $orderby: the metadata endpoint rejects it (`$orderby` returns
    // 0x80060888 "The query parameter ... is not supported").
  },

  attributes: {
    summary: '某个实体的全部字段（属性）定义',
    entityScoped: true,
    path: (args) => `EntityDefinitions(LogicalName='${odataString(args.entity)}')/Attributes`,
    select: 'LogicalName,SchemaName,AttributeType,AttributeTypeName,IsCustomAttribute,RequiredLevel,IsPrimaryId,IsValidForCreate,IsValidForUpdate,IsValidForRead',
  },

  keys: {
    summary: '某个实体的备用键定义',
    entityScoped: true,
    path: (args) => `EntityDefinitions(LogicalName='${odataString(args.entity)}')/Keys`,
  },

  one_to_many_relationships: {
    summary: '某个实体的一对多关系',
    entityScoped: true,
    path: (args) => `EntityDefinitions(LogicalName='${odataString(args.entity)}')/OneToManyRelationships`,
  },

  many_to_many_relationships: {
    summary: '某个实体的多对多关系',
    entityScoped: true,
    path: (args) => `EntityDefinitions(LogicalName='${odataString(args.entity)}')/ManyToManyRelationships`,
  },

  forms: {
    summary: '系统表单定义（不含 formxml 正文，需要时用 select 显式取）',
    entityFilter: entityFilter.forms,
    path: () => 'systemforms',
    select: 'formid,name,type,objecttypecode,description,ismanaged,modifiedon',
    orderby: 'name asc',
  },

  views: {
    summary: '视图（savedquery）：名称、类型、是否默认',
    entityFilter: entityFilter.views,
    path: () => 'savedqueries',
    select: 'savedqueryid,name,querytype,returnedtypecode,isdefault,ismanaged,modifiedon',
    orderby: 'name asc',
  },

  workflows: {
    summary: '工作流 / 流程（含业务规则；按 category 区分）',
    entityFilter: entityFilter.workflows,
    path: () => 'workflows',
    select: 'workflowid,name,category,type,statecode,statuscode,primaryentity,createdon,modifiedon',
    orderby: 'name asc',
  },

  business_rules: {
    summary: '业务规则（workflows 中 category = 2 的子集）',
    entityFilter: entityFilter.business_rules,
    path: () => 'workflows',
    filter: "category eq 2",
    select: 'workflowid,name,category,statecode,statuscode,primaryentity,modifiedon',
    orderby: 'name asc',
  },

  plugin_assemblies: {
    summary: '插件程序集：名称、版本、部署方式',
    path: () => 'pluginassemblies',
    select: 'pluginassemblyid,name,version,culture,publickeytoken,isolationmode,sourcetype,ismanaged',
    orderby: 'name asc',
  },

  plugin_types: {
    summary: '插件类型（类）：完整类型名与所属程序集',
    path: () => 'plugintypes',
    select: 'plugintypeid,typename,pluginassemblyid,isworkflowactivity,friendlyname',
    orderby: 'typename asc',
  },

  plugin_steps: {
    summary: '插件步骤（SDK 消息处理步骤）：消息、阶段、模式、过滤属性',
    path: () => 'sdkmessageprocessingsteps',
    select: 'sdkmessageprocessingstepid,name,stage,mode,rank,statecode,filteringattributes,configuration,plugintypeid,sdkmessageid',
    orderby: 'name asc',
  },

  web_resources: {
    summary: 'Web 资源清单（默认不含 content 正文）',
    path: () => 'webresourceset',
    select: 'webresourceid,name,displayname,webresourcetype,ismanaged,modifiedon',
    orderby: 'name asc',
  },

  solutions: {
    summary: '解决方案清单：唯一名、版本、是否托管、安装时间',
    path: () => 'solutions',
    select: 'solutionid,uniquename,friendlyname,version,ismanaged,installedon,isvisible,publisherid',
    orderby: 'uniquename asc',
  },

  solution_components: {
    summary: '解决方案分量：哪个组件属于哪个解决方案（判断是否纳管的依据）',
    path: () => 'solutioncomponents',
    // Lookup columns come back as `_solutionid_value`, not `solutionid`.
    select: 'solutioncomponentid,componenttype,objectid,_solutionid_value,rootcomponentbehavior',
  },

  custom_apis: {
    summary: '自定义 API 定义',
    path: () => 'customapis',
    select: 'customapiid,uniquename,name,displayname,boundentitylogicalname,isfunction,isprivate',
    orderby: 'uniquename asc',
  },

  sitemaps: {
    summary: '站点地图（默认不含 sitemapxml 正文）',
    path: () => 'sitemaps',
    select: 'sitemapid,sitemapname,componentstate,ismanaged',
  },

  option_sets: {
    summary: '全局选项集定义',
    path: () => 'GlobalOptionSetDefinitions',
    select: 'Name,DisplayName,IsCustomOptionSet,OptionSetType,IsGlobal',
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
  forms: 'name',
  views: 'name',
  workflows: 'name',
  business_rules: 'name',
  plugin_assemblies: 'name',
  plugin_types: 'typename',
  plugin_steps: 'name',
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
  solutions: ['version', 'ismanaged'],
  web_resources: ['webresourcetype'],
  organization: ['version', 'organizationstructure'],
}

/**
 * Compose the final `$filter` from the resource's entity filter and the
 * caller's own expression.
 * @returns the filter string, or undefined.
 */
export function composeFilter(definition, args) {
  const parts = []
  if (definition.filter) parts.push(`(${definition.filter})`)
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
