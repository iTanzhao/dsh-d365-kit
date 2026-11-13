/**
 * Dataverse error codes that are worth explaining on the spot.
 *
 * A `0x80048d19` with no interpretation costs a person an hour: the message
 * says the *shape* of one property is wrong, not which rule was broken. This
 * table turns the code into the next thing to check. It is deliberately small:
 * only codes whose cause is unambiguous get an entry, because a wrong hint is
 * worse than none.
 */

export const ERROR_CODES = {
  '0x80048d19': {
    summary: '载荷里某个属性的形状不对：服务端在读一个标量值，报文里却是注解、对象或 null 以外的结构（常见于 lookup）',
    hint: 'lookup 要写成 "<导航属性名>@odata.bind": "/<集合名>(<guid>)"，不是字段逻辑名、也不是裸 GUID；选项集写数值、多选写数组、布尔写 true/false。导航属性名与字段逻辑名可能只是大小写不同（contoso_approverid → contoso_ApproverId），用 d365_metadata resource=one_to_many_relationships 看 ReferencingEntityNavigationPropertyName。',
  },
  '0x80060888': {
    summary: '请求里有一个这个端点不认识的属性名或查询参数',
    hint: '属性名大小写敏感：元数据端点（EntityDefinitions 等）要 LogicalName，实体表上要逻辑名小写（name、createdon）；lookup 列要写 _<字段>_value；派生属性（DefaultValue、Targets、Options）要先用 cast 指到具体类型。工具只会在 $select 里剔除同名的那一列——名字写在 $filter / $orderby 里时直接报 unknown-property（改写 filter 等于换一个问题）。只有「查询参数不被支持」时，工具才会逐项去掉 $top / $orderby / $select 重试。',
  },
  '0x80040216': {
    summary: '对象不存在：按这个名字或 id 找不到记录',
    hint: '先确认环境对不对（不同环境的自定义表可用性不同），再用不带 filter 的查询确认记录真的存在。',
  },
  '0x80040217': {
    summary: '对象不存在：按这个名字或 id 找不到记录',
    hint: '先确认环境对不对（不同环境的自定义表可用性不同），再用不带 filter 的查询确认记录真的存在。',
  },
  '0x80040333': {
    summary: '重复检测规则拦截了这次创建：目标里已有匹配的记录',
    hint: '先查目标环境里是否已有同名/同键记录，按需要改成 update 或对这条记录开启 MSCRM.SuppressDuplicateDetection。',
  },
  '0x80044150': {
    summary: '记录在读取之后被别人改过（并发冲突 / 状态已变化）',
    hint: '重新读一次当前行再决定怎么写；如果是状态字段，确认它现在是不是已经是你想要的值。',
  },
  '0x80048423': {
    summary: '组件属于某个受管解决方案，不能在这里直接改',
    hint: '受管组件只能在源环境改，再作为新版本导入；要在当前环境改就先把它变成非受管（或建一个新的非受管组件）。',
  },
  '0x8004a0f6': {
    summary: '操作违反了当前记录状态：状态机不允许这一步',
    hint: '先看 statecode/statuscode 与业务流程阶段，撤销/激活类操作只能在特定状态下执行。',
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
  return `${entry.summary}。${entry.hint}`
}
