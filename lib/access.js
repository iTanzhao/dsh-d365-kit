/**
 * Security roles: who holds which one, what each one may do, and the plans that
 * change them.
 *
 * Dataverse stores a role per business unit, so the same role name repeats once
 * per BU and holds its own privileges. Everything here therefore works on role
 * *records* (GUIDs) and only prints names; "give Alice the Salesperson role" is
 * ambiguous on purpose until a business unit is named.
 */
import { randomUUID } from 'node:crypto'
import { D365Error } from './errors.js'
import { t } from './i18n.js'
import { makeClient } from './runtime.js'
import { allows, readPolicy } from './write-policy.js'
import { claimPlan, createPlan, readPlan, recordChange, releasePlan, setPlanStatus } from './write-store.js'

export const ACCESS_CAPABILITY = 'role.admin'

/** PrivilegeDepthMask: 1 basic (own), 2 local (BU), 4 deep (BU + children), 8 global. */
export const DEPTH_LABELS = { 1: 'Basic (user)', 2: 'Local (business unit)', 4: 'Deep (business unit and children)', 8: 'Global (organization)' }

/**
 * Access rights are bit flags, not a 1..8 sequence: measured in this org,
 * `prvReadAccount` is 1, `prvWriteAccount` 2, `prvAppendAccount` 4,
 * `prvAppendToAccount` 16, `prvCreateAccount` 32, `prvDeleteAccount` 65536,
 * `prvShareAccount` 262144 and `prvAssignAccount` 524288. A label table keyed
 * on 1..8 printed creates as reads, which is worse than printing the number.
 */
export const RIGHT_LABELS = {
  1: 'Read',
  2: 'Write',
  4: 'Append',
  16: 'Append To',
  32: 'Create',
  65536: 'Delete',
  262144: 'Share',
  524288: 'Assign',
}

const DEPTH_BY_LABEL = {
  basic: 1, own: 1, user: 1,
  local: 2, businessunit: 2,
  deep: 4, parentchild: 4,
  global: 8, organization: 8,
}

const RIGHT_BY_LABEL = {
  create: 32,
  read: 1,
  write: 2,
  delete: 65536,
  append: 4,
  appendto: 16,
  assign: 524288,
  share: 262144,
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const depthOf = (label) => {
  const value = DEPTH_BY_LABEL[String(label ?? '').toLowerCase()]
  if (!value) throw new D365Error(t('access.error.depth', { label }), { hint: t('access.hint.depths') })
  return value
}

export const rightOf = (label) => {
  const value = RIGHT_BY_LABEL[String(label ?? '').toLowerCase()]
  if (!value) throw new D365Error(t('access.error.right', { label }), { hint: t('access.hint.rights') })
  return value
}

const chunk = (items, size) => {
  const out = []
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size))
  return out
}

const odataString = (value) => String(value).replace(/'/g, "''")

async function paged(client, path, params, signal, limit = 2000) {
  const page = await client.getPaged(path, params, limit, signal)
  return page.records
}

const setCache = new WeakMap()

/**
 * Entity set names are per environment: this org maps `roleprivileges` to
 * `roleprivilegescollection`, and guessing produced a 404 before. Read the
 * real name once per client, then reuse it.
 */
async function entitySet(client, logical, signal) {
  let cache = setCache.get(client)
  if (!cache) {
    cache = new Map()
    setCache.set(client, cache)
  }
  if (cache.has(logical)) return cache.get(logical)
  const row = await client.requestJson(
    client.buildUrl(`EntityDefinitions(LogicalName='${odataString(logical)}')`, { $select: 'EntitySetName' }),
    { signal },
  )
  const set = row?.EntitySetName
  if (!set) {
    throw new D365Error(t('access.error.entityMissing', { entity: logical }), {
      code: 'entity-not-found',
      hint: t('access.hint.securityEntity'),
    })
  }
  cache.set(logical, set)
  return set
}

/** Roles matching a name (or one role, by GUID). Name matches may span BUs. */
export async function resolveRoles(client, role, signal) {
  const name = String(role ?? '').trim()
  if (!name) throw new D365Error(t('access.error.roleRequired'), { hint: t('access.hint.role') })
  const select = 'roleid,name,_businessunitid_value,ismanaged,roletemplateid'
  if (GUID.test(name)) {
    const row = await client.getOne(`${await entitySet(client, 'role', signal)}(${name})`, { $select: select }, signal)
    return row ? [row] : []
  }
  return paged(client, await entitySet(client, 'role', signal), {
    $select: select,
    $filter: `name eq '${odataString(name)}'`,
    $orderby: 'name asc',
    __noTop: true,
  }, signal)
}

/** One role or none — for anything that writes, "two matches" must stop. */
export async function resolveOneRole(client, args, signal) {
  const request = typeof args === 'string' ? { role: args } : args ?? {}
  let rows = await resolveRoles(client, request.role, signal)
  if (!rows.length) throw new D365Error(t('access.error.roleNotFound', { role: request.role }), { code: 'role-not-found', hint: t('access.hint.roles') })
  const unit = request.businessunit ? await resolveBusinessUnit(client, request.businessunit, signal) : null
  if (unit) {
    rows = rows.filter((row) => row._businessunitid_value === unit.businessunitid)
    if (!rows.length) {
      throw new D365Error(t('access.error.roleOutsideUnit', { role: request.role, unit: unit.name }), {
        code: 'role-not-in-unit',
        hint: t('access.hint.roleUnit'),
      })
    }
  }
  if (rows.length > 1) {
    const units = await readBusinessUnitNames(client, rows.map((row) => row._businessunitid_value), signal)
    const candidates = rows
      .slice(0, 10)
      .map((row) => `- ${row.roleid}（${units.get(row._businessunitid_value) ?? t('access.unknownBusinessUnit')}）`)
      .join('\n')
    throw new D365Error(t('access.error.ambiguousRole', { role: request.role, count: rows.length }), {
      code: 'ambiguous-role',
      hint: t('access.hint.ambiguousRole', { candidates, more: rows.length > 10 ? t('access.hint.moreRoles', { count: rows.length - 10 }) : '' }),
    })
  }
  return rows[0]
}

/** A business unit by name or GUID — how a duplicated role name gets pinned down. */
export async function resolveBusinessUnit(client, value, signal) {
  const name = String(value ?? '').trim()
  if (!name) return null
  const select = 'businessunitid,name'
  if (GUID.test(name)) {
    const row = await client.getOne(`${await entitySet(client, 'businessunit', signal)}(${name})`, { $select: select }, signal)
    if (!row) throw new D365Error(t('access.error.unitNotFound', { unit: name }), { code: 'business-unit-not-found' })
    return row
  }
  const rows = await paged(client, await entitySet(client, 'businessunit', signal), { $select: select, $filter: `name eq '${odataString(name)}'`, __noTop: true }, signal)
  if (!rows.length) {
    throw new D365Error(t('access.error.unitNotFound', { unit: name }), {
      code: 'business-unit-not-found',
      hint: t('access.hint.unitName'),
    })
  }
  if (rows.length > 1) {
    throw new D365Error(t('access.error.ambiguousUnit', { unit: name, count: rows.length }), {
      code: 'ambiguous-business-unit',
      hint: t('access.hint.useId'),
    })
  }
  return rows[0]
}

async function readBusinessUnitNames(client, ids, signal) {
  const names = new Map()
  const unique = [...new Set(ids.filter(Boolean))]
  for (const batch of chunk(unique, 20)) {
    const filter = batch.map((id) => `businessunitid eq ${id}`).join(' or ')
    const rows = await paged(client, await entitySet(client, 'businessunit', signal), { $select: 'businessunitid,name', $filter: filter, __noTop: true }, signal)
    for (const row of rows) names.set(row.businessunitid, row.name)
  }
  return names
}

const roleLabel = (role, units) => {
  const unit = units.get(role._businessunitid_value)
  return unit ? `${role.name}（${unit}）` : role.name
}

/** Every role in the environment, grouped by name so the BU copies are visible. */
export async function listRoles(client, args, signal) {
  const filter = String(args.filter ?? '').trim() || (args.name ? `contains(name,'${odataString(args.name)}')` : '')
  const rows = await paged(client, await entitySet(client, 'role', signal), {
    $select: 'roleid,name,_businessunitid_value,ismanaged',
    ...(filter ? { $filter: filter } : {}),
    $orderby: 'name asc',
  }, signal, Math.min(Number(args.top ?? 200), 1000) || 200)

  const units = await readBusinessUnitNames(client, rows.map((row) => row._businessunitid_value), signal)
  const groups = new Map()
  for (const row of rows) {
    const key = row.name
    if (!groups.has(key)) groups.set(key, { name: key, total: 0, managed: 0, units: [], ids: [] })
    const group = groups.get(key)
    group.total += 1
    if (row.ismanaged) group.managed += 1
    group.units.push(units.get(row._businessunitid_value) ?? t('access.unknownBusinessUnit'))
    group.ids.push(row.roleid)
  }
  return { rows, groups: [...groups.values()], units }
}

/** Users and teams that hold a role, plus the users a holding team brings in. */
export async function whoHasRole(client, args, signal) {
  const role = await resolveOneRole(client, args, signal)
  const units = await readBusinessUnitNames(client, [role._businessunitid_value], signal)

  const links = await paged(client, await entitySet(client, 'systemuserroles', signal), {
    $select: 'systemuserid,roleid',
    $filter: `roleid eq ${role.roleid}`,
    __noTop: true,
  }, signal)
  const userIds = links.map((row) => row.systemuserid).filter(Boolean)

  const teamLinks = await paged(client, await entitySet(client, 'teamroles', signal), {
    $select: 'teamid,roleid',
    $filter: `roleid eq ${role.roleid}`,
    __noTop: true,
  }, signal)
  const teamIds = teamLinks.map((row) => row.teamid).filter(Boolean)

  const users = new Map()
  for (const batch of chunk(userIds, 20)) {
    const filter = batch.map((id) => `systemuserid eq ${id}`).join(' or ')
    const rows = await paged(client, await entitySet(client, 'systemuser', signal), { $select: 'systemuserid,fullname,domainname,isdisabled', $filter: filter, __noTop: true }, signal)
    for (const row of rows) users.set(row.systemuserid, row)
  }

  const teams = []
  for (const batch of chunk(teamIds, 20)) {
    const filter = batch.map((id) => `teamid eq ${id}`).join(' or ')
    const rows = await paged(client, await entitySet(client, 'team', signal), { $select: 'teamid,name,teamtype,isdefault', $filter: filter, __noTop: true }, signal)
    teams.push(...rows)
  }

  // Members of those teams inherit the role; counting them is what makes
  // "88 people" and "who really has this" different questions.
  const members = new Map()
  for (const batch of chunk(teamIds, 20)) {
    const filter = batch.map((id) => `teamid eq ${id}`).join(' or ')
    const rows = await paged(client, await entitySet(client, 'teammembership', signal), { $select: 'teamid,systemuserid', $filter: filter, __noTop: true }, signal)
    for (const row of rows) {
      if (!members.has(row.teamid)) members.set(row.teamid, [])
      members.get(row.teamid).push(row.systemuserid)
    }
  }

  const inherited = new Set()
  for (const list of members.values()) for (const id of list) if (!userIds.includes(id)) inherited.add(id)

  const inheritedUsers = new Map()
  for (const batch of chunk([...inherited], 20)) {
    const filter = batch.map((id) => `systemuserid eq ${id}`).join(' or ')
    const rows = await paged(client, await entitySet(client, 'systemuser', signal), { $select: 'systemuserid,fullname,domainname,isdisabled', $filter: filter, __noTop: true }, signal)
    for (const row of rows) inheritedUsers.set(row.systemuserid, row)
  }

  return {
    role,
    label: roleLabel(role, units),
    directUsers: userIds.map((id) => users.get(id)).filter(Boolean),
    teams: teams.map((team) => ({ ...team, memberCount: (members.get(team.teamid) ?? []).length })),
    inheritedUsers: [...inheritedUsers.values()],
  }
}

/** One user's roles: the ones assigned to them, and the ones their teams bring. */
export async function userRoles(client, args, signal) {
  const key = String(args.user ?? '').trim()
  if (!key) throw new D365Error(t('access.error.userRequired'), { hint: t('access.hint.user') })
  const select = 'systemuserid,fullname,domainname,isdisabled,_businessunitid_value'
  let rows
  if (GUID.test(key)) {
    const row = await client.getOne(`${await entitySet(client, 'systemuser', signal)}(${key})`, { $select: select }, signal)
    rows = row ? [row] : []
  } else {
    rows = await paged(client, await entitySet(client, 'systemuser', signal), {
      $select: select,
      $filter: `domainname eq '${odataString(key)}' or internalemailaddress eq '${odataString(key)}' or fullname eq '${odataString(key)}'`,
      __noTop: true,
    }, signal)
  }
  if (!rows.length) throw new D365Error(t('access.error.userNotFound', { user: key }), { code: 'user-not-found', hint: t('access.hint.userLookup') })
  if (rows.length > 1) {
    throw new D365Error(t('access.error.ambiguousUser', { user: key, count: rows.length }), {
      code: 'ambiguous-user',
      hint: rows.map((row) => `${row.fullname}（${row.domainname ?? t('access.noDomain')}）`).join('、'),
    })
  }

  const user = rows[0]
  const directLinks = await paged(client, await entitySet(client, 'systemuserroles', signal), {
    $select: 'systemuserid,roleid',
    $filter: `systemuserid eq ${user.systemuserid}`,
    __noTop: true,
  }, signal)

  const memberships = await paged(client, await entitySet(client, 'teammembership', signal), {
    $select: 'teamid,systemuserid',
    $filter: `systemuserid eq ${user.systemuserid}`,
    __noTop: true,
  }, signal)
  const teamIds = memberships.map((row) => row.teamid).filter(Boolean)

  const teamLinks = []
  for (const batch of chunk(teamIds, 20)) {
    const filter = batch.map((id) => `teamid eq ${id}`).join(' or ')
    const links = await paged(client, await entitySet(client, 'teamroles', signal), { $select: 'teamid,roleid', $filter: filter, __noTop: true }, signal)
    teamLinks.push(...links)
  }

  const roleIds = [...new Set([...directLinks.map((row) => row.roleid), ...teamLinks.map((row) => row.roleid)].filter(Boolean))]
  const roles = new Map()
  for (const batch of chunk(roleIds, 20)) {
    const filter = batch.map((id) => `roleid eq ${id}`).join(' or ')
    const found = await paged(client, await entitySet(client, 'role', signal), { $select: 'roleid,name,_businessunitid_value,ismanaged', $filter: filter, __noTop: true }, signal)
    for (const row of found) roles.set(row.roleid, row)
  }
  const units = await readBusinessUnitNames(client, [...roles.values()].map((row) => row._businessunitid_value), signal)
  const teamNames = new Map()
  for (const batch of chunk(teamIds, 20)) {
    const filter = batch.map((id) => `teamid eq ${id}`).join(' or ')
    const found = await paged(client, await entitySet(client, 'team', signal), { $select: 'teamid,name', $filter: filter, __noTop: true }, signal)
    for (const row of found) teamNames.set(row.teamid, row.name)
  }

  return {
    user,
    direct: directLinks.map((link) => ({ role: roles.get(link.roleid), label: roleLabel(roles.get(link.roleid) ?? {}, units), via: null })).filter((item) => item.role),
    inherited: teamLinks
      .map((link) => ({
        role: roles.get(link.roleid),
        label: roleLabel(roles.get(link.roleid) ?? {}, units),
        via: teamNames.get(link.teamid) ?? link.teamid,
      }))
      .filter((item) => item.role),
  }
}

const parsePrivilegeName = (name) => {
  const match = /^prv([A-Za-z]+?)([A-Z].*)$/.exec(String(name ?? ''))
  if (!match) return undefined
  const right = RIGHT_BY_LABEL[match[1].toLowerCase()]
  return right ? { right, entity: match[2] } : undefined
}

/**
 * What one role may do, per table.
 *
 * `privilegedepthmask` is the whole answer to "at what level": 1 is the user's
 * own records, 2 their business unit, 4 the BU and its children, 8 the whole
 * organization. Printing it as a word rather than a number is the point — 8
 * where you expected 2 is how a role quietly becomes an administrator.
 */
export async function rolePrivileges(client, args, signal) {
  const role = await resolveOneRole(client, args, signal)
  const units = await readBusinessUnitNames(client, [role._businessunitid_value], signal)
  const rolePrivilegeSet = await entitySet(client, 'roleprivileges', signal)
  const privilegeSet = await entitySet(client, 'privilege', signal)
  const typeCodeSet = await entitySet(client, 'privilegeobjecttypecodes', signal)

  const links = await paged(client, rolePrivilegeSet, {
    $select: 'privilegeid,privilegedepthmask,roleid',
    $filter: `roleid eq ${role.roleid}`,
    __noTop: true,
  }, signal, 50000)

  const privileges = new Map()
  for (const batch of chunk([...new Set(links.map((row) => row.privilegeid))], 20)) {
    const filter = batch.map((id) => `privilegeid eq ${id}`).join(' or ')
    const rows = await paged(client, privilegeSet, { $select: 'privilegeid,name,accessright,canbebasic,canbelocal,canbedeep,canbeglobal', $filter: filter, __noTop: true }, signal)
    for (const row of rows) privileges.set(row.privilegeid, row)
  }

  // Object type codes are the only reliable table identity: privilege names use
  // the schema-ish name, which disagrees with the logical name for custom tables.
  const typeCodes = new Map()
  const privilegeIds = [...privileges.keys()]
  for (const batch of chunk(privilegeIds, 20)) {
    // `privilegeid` on this table is a lookup, so it is filtered and read via
    // the `_privilegeid_value` column rather than the navigation property.
    const filter = batch.map((id) => `_privilegeid_value eq ${id}`).join(' or ')
    const rows = await paged(client, typeCodeSet, { $select: '_privilegeid_value,objecttypecode', $filter: filter, __noTop: true }, signal)
    for (const row of rows) {
      // One privilege can carry several object type codes (`prvReadAccount`
      // applies to account *and* customeraddress), so keep all of them: keeping
      // only the last one hid read on the table people asked about.
      const key = row._privilegeid_value
      const list = typeCodes.get(key)
      if (list) list.push(row.objecttypecode)
      else typeCodes.set(key, [row.objecttypecode])
    }
  }

  const entityNames = new Map()
  if (typeCodes.size) {
    try {
      const definitions = await paged(client, 'EntityDefinitions', { $select: 'LogicalName,ObjectTypeCode', __noTop: true }, signal)
      for (const definition of definitions) entityNames.set(String(definition.ObjectTypeCode), definition.LogicalName)
    } catch {
      // Metadata may be switched off for this environment; the privilege name
      // still tells the table, just less precisely.
    }
  }

  const rows = []
  for (const link of links) {
    const privilege = privileges.get(link.privilegeid)
    if (!privilege) continue
    const right = Number(privilege.accessright) || parsePrivilegeName(privilege.name)?.right
    if (!right) continue
    const parsed = parsePrivilegeName(privilege.name)
    // `objecttypecode` is numeric in some orgs and the logical name in others;
    // a privilege may cover several tables, so every code becomes its own row.
    const codes = typeCodes.get(link.privilegeid) ?? []
    const entities = codes.length
      ? codes.map((code) => entityNames.get(String(code)) ?? (typeof code === 'string' && code.trim() ? code.trim() : String(code)))
      : [parsed?.entity ?? t('access.global')]
    for (const entity of entities) {
      rows.push({
        entity,
        right,
        rightLabel: RIGHT_LABELS[right] ?? String(right),
        depth: Number(link.privilegedepthmask) || 0,
        depthLabel: DEPTH_LABELS[Number(link.privilegedepthmask)] ?? t('access.notSet'),
        privilege: privilege.name,
        privilegeId: privilege.privilegeid,
      })
    }
  }

  const entityFilter = String(args.entity ?? '').trim().toLowerCase()
  const filtered = entityFilter ? rows.filter((row) => row.entity.toLowerCase() === entityFilter) : rows

  const tables = new Map()
  for (const row of filtered) {
    if (!tables.has(row.entity)) tables.set(row.entity, { entity: row.entity, cells: {}, deepest: 0 })
    const table = tables.get(row.entity)
    table.cells[row.rightLabel] = row.depthLabel
    table.deepest = Math.max(table.deepest, row.depth)
  }

  return {
    role,
    label: roleLabel(role, units),
    rows: filtered,
    tables: [...tables.values()].sort((a, b) => a.entity.localeCompare(b.entity)),
    total: rows.length,
  }
}

/* ------------------------------------------------------------------ writing */

async function currentUserRoleLink(client, userId, roleId, signal) {
  const rows = await paged(client, await entitySet(client, 'systemuserroles', signal), {
    $select: 'systemuserid,roleid',
    $filter: `systemuserid eq ${userId} and roleid eq ${roleId}`,
    __noTop: true,
  }, signal)
  return rows.length > 0
}

async function currentTeamRoleLink(client, teamId, roleId, signal) {
  const rows = await paged(client, await entitySet(client, 'teamroles', signal), {
    $select: 'teamid,roleid',
    $filter: `teamid eq ${teamId} and roleid eq ${roleId}`,
    __noTop: true,
  }, signal)
  return rows.length > 0
}

async function resolvePrincipal(client, args, signal) {
  const wantsTeam = Boolean(args.team)
  const key = String(args.team ?? args.user ?? '').trim()
  if (!key) throw new D365Error(t('access.error.principalRequired'), { hint: t('access.hint.principal') })

  if (wantsTeam) {
    const rows = GUID.test(key)
      ? [await client.getOne(`${await entitySet(client, 'team', signal)}(${key})`, { $select: 'teamid,name,teamtype' }, signal)].filter(Boolean)
      : await paged(client, await entitySet(client, 'team', signal), { $select: 'teamid,name,teamtype', $filter: `name eq '${odataString(key)}'`, __noTop: true }, signal)
    if (!rows.length) throw new D365Error(t('access.error.teamNotFound', { team: key }), { code: 'team-not-found' })
    if (rows.length > 1) throw new D365Error(t('access.error.ambiguousTeam', { team: key, count: rows.length }), { code: 'ambiguous-team', hint: t('access.hint.useTeamId') })
    return { kind: 'team', id: rows[0].teamid, name: rows[0].name, set: 'teams' }
  }

  const rows = GUID.test(key)
    ? [await client.getOne(`${await entitySet(client, 'systemuser', signal)}(${key})`, { $select: 'systemuserid,fullname,domainname,isdisabled' }, signal)].filter(Boolean)
    : await paged(client, await entitySet(client, 'systemuser', signal), {
      $select: 'systemuserid,fullname,domainname,isdisabled',
      $filter: `domainname eq '${odataString(key)}' or internalemailaddress eq '${odataString(key)}' or fullname eq '${odataString(key)}'`,
      __noTop: true,
    }, signal)
  if (!rows.length) throw new D365Error(t('access.error.userNotFound', { user: key }), { code: 'user-not-found' })
  if (rows.length > 1) {
    throw new D365Error(t('access.error.ambiguousUser', { user: key, count: rows.length }), {
      code: 'ambiguous-user',
      hint: t('access.hint.useGuidList', { values: rows.map((row) => `${row.fullname}=${row.systemuserid}`).join(', ') }),
    })
  }
  return { kind: 'user', id: rows[0].systemuserid, name: rows[0].fullname, set: 'systemusers', disabled: rows[0].isdisabled }
}

/** Plan one role assignment or removal. */
export async function planRoleMembership(config, envKey, args, signal) {
  const env = config.environments[envKey]
  if (!env) throw new D365Error(t('access.error.unknownEnvironment', { env: envKey }), { code: 'unknown-environment' })
  const client = makeClient(env, config)
  const role = await resolveOneRole(client, args, signal)
  const principal = await resolvePrincipal(client, args, signal)
  const add = args.action === 'plan-assign-role'

  const held = principal.kind === 'team'
    ? await currentTeamRoleLink(client, principal.id, role.roleid, signal)
    : await currentUserRoleLink(client, principal.id, role.roleid, signal)

  const units = await readBusinessUnitNames(client, [role._businessunitid_value], signal)
  const label = roleLabel(role, units)
  const skips = []
  if (add && held) skips.push({ reason: t('access.skip.alreadyHas', { name: principal.name }) })
  if (!add && !held) skips.push({ reason: t('access.skip.alreadyLacks', { name: principal.name }) })
  if (principal.kind === 'user' && principal.disabled && add) {
    throw new D365Error(t('access.error.principalDisabled', { name: principal.name }), { code: 'principal-disabled', hint: t('access.hint.enableUser') })
  }

  const operations = skips.length
    ? []
    : [{
      type: add ? 'AssociateRole' : 'DisassociateRole',
      principalKind: principal.kind,
      principalId: principal.id,
      principalName: principal.name,
      roleId: role.roleid,
      roleName: label,
      summary: add
        ? t('access.plan.assignSummary', { principal: principal.kind === 'team' ? t('access.team') : t('access.user'), name: principal.name, role: label })
        : t('access.plan.removeSummary', { principal: principal.kind === 'team' ? t('access.team') : t('access.user'), name: principal.name, role: label }),
    }]

  return {
    kind: 'access',
    capability: ACCESS_CAPABILITY,
    envKey,
    envUrl: env.url,
    title: add ? t('access.plan.assignTitle', { name: principal.name }) : t('access.plan.removeTitle', { name: principal.name }),
    role: { id: role.roleid, name: role.name, label },
    principal,
    operations,
    skipped: skips,
    requestedBy: args.requestedBy ?? 'agent',
    rationale: args.rationale,
  }
}

async function resolvePrivilegesByName(client, names, signal) {
  const resolved = new Map()
  for (const batch of chunk(names, 20)) {
    const filter = batch.map((name) => `name eq '${odataString(name)}'`).join(' or ')
    const privilegeSet = await entitySet(client, 'privilege', signal)
    const rows = await paged(client, privilegeSet, { $select: 'privilegeid,name,accessright', $filter: filter, __noTop: true }, signal)
    for (const row of rows) resolved.set(row.name.toLowerCase(), row)
  }
  const missing = names.filter((name) => !resolved.has(name.toLowerCase()))
  if (missing.length) {
    throw new D365Error(t('access.error.privilegesNotFound', { privileges: missing.join(', ') }), {
      code: 'privilege-not-found',
      hint: t('access.hint.privilegeName'),
    })
  }
  return names.map((name) => resolved.get(name.toLowerCase()))
}

/**
 * Plan adding or removing privileges on one role.
 *
 * `privileges` is a list of either `"prvWriteAccount"` or
 * `{ name: "prvWriteAccount", depth: "global" }`; depth defaults to the role's
 * current depth when the privilege is already there, so "make it deeper" is not
 * a silent side effect of re-adding.
 */
export async function planPrivileges(config, envKey, args, signal) {
  const env = config.environments[envKey]
  if (!env) throw new D365Error(t('access.error.unknownEnvironment', { env: envKey }), { code: 'unknown-environment' })
  const client = makeClient(env, config)
  const role = await resolveOneRole(client, args, signal)
  const units = await readBusinessUnitNames(client, [role._businessunitid_value], signal)
  const label = roleLabel(role, units)

  const requested = (Array.isArray(args.privileges) ? args.privileges : [])
    .map((item) => (typeof item === 'string' ? { name: item.trim(), depth: undefined } : { name: String(item?.name ?? '').trim(), depth: item?.depth }))
    .filter((item) => item.name)
  if (!requested.length) {
    throw new D365Error(t('access.error.privilegesRequired'), {
      code: 'missing-privileges',
      hint: t('access.hint.privileges'),
    })
  }

  const resolved = await resolvePrivilegesByName(client, requested.map((item) => item.name), signal)
  const rolePrivilegeSet = await entitySet(client, 'roleprivileges', signal)
  const existing = await paged(client, rolePrivilegeSet, {
    $select: 'privilegeid,privilegedepthmask',
    $filter: `roleid eq ${role.roleid}`,
    __noTop: true,
  }, signal)
  const current = new Map(existing.map((row) => [row.privilegeid, Number(row.privilegedepthmask) || 0]))

  const add = args.action === 'plan-add-privileges'
  const operations = []
  const skipped = []

  for (const [index, item] of requested.entries()) {
    const privilege = resolved[index]
    const depthMask = current.get(privilege.privilegeid) ?? 0
    if (add) {
      const depth = item.depth === undefined ? (depthMask || 8) : depthOf(item.depth)
      if (depthMask === depth) {
        skipped.push({ reason: t('access.skip.sameDepth', { privilege: privilege.name }) })
        continue
      }
      operations.push({
        type: 'AddPrivileges',
        roleId: role.roleid,
        roleName: label,
        privilegeId: privilege.privilegeid,
        privilegeName: privilege.name,
        depth,
        depthLabel: DEPTH_LABELS[depth],
        summary: t('access.plan.addPrivilegeSummary', { role: label, privilege: privilege.name, depth: DEPTH_LABELS[depth] }),
      })
    } else {
      if (!depthMask) {
        skipped.push({ reason: t('access.skip.notHeld', { privilege: privilege.name }) })
        continue
      }
      operations.push({
        type: 'RemovePrivileges',
        roleId: role.roleid,
        roleName: label,
        privilegeId: privilege.privilegeid,
        privilegeName: privilege.name,
        depth: depthMask,
        depthLabel: DEPTH_LABELS[depthMask],
        summary: t('access.plan.removePrivilegeSummary', { role: label, privilege: privilege.name }),
      })
    }
  }

  return {
    kind: 'access',
    capability: ACCESS_CAPABILITY,
    envKey,
    envUrl: env.url,
    title: add ? t('access.plan.addPrivilegesTitle') : t('access.plan.removePrivilegesTitle'),
    role: { id: role.roleid, name: role.name, label },
    operations,
    skipped,
    requestedBy: args.requestedBy ?? 'agent',
    rationale: args.rationale,
  }
}

/** Persist an access plan with the shared pending-writes store. */
export async function saveAccessPlan(config, plan) {
  return createPlan(config, { ...plan, id: `${Date.now().toString(36)}-${randomUUID().slice(0, 5)}` })
}

/**
 * Run one access plan.
 *
 * Privileges go through the `AddPrivilegesRole` / `RemovePrivilegeRole` messages
 * rather than editing `roleprivileges` rows: the message updates the role's
 * in-memory security cache, the table write does not.
 */
export async function executeAccessPlan(config, plan, signal, hooks = {}) {
  const env = config.environments[plan.envKey]
  if (!env) throw new D365Error(t('access.error.unknownEnvironment', { env: plan.envKey }), { code: 'unknown-environment' })

  // The chat tool checks this before asking, but the plan file is on disk: the
  // executor is the last place that can refuse a revoked capability.
  const policy = await readPolicy(config.configFile)
  if (!allows(policy, plan.envKey, ACCESS_CAPABILITY)) {
    throw new D365Error(t('access.error.roleAdminForbidden', { env: plan.envKey }), {
      code: 'role-admin-forbidden',
      hint: t('access.hint.roleAdmin'),
    })
  }

  // Same claim as the metadata pipeline: two windows that both read "pending"
  // must not both assign the role.
  await claimPlan(config, plan.id)
  let target
  try {
    target = await readPlan(config, plan.id)
    if (!target || (target.status ?? 'pending') !== 'pending') {
      throw new D365Error(t('access.error.planNotPending', { id: plan.id }), {
        code: 'plan-not-pending',
        hint: t('access.hint.planCancelled'),
      })
    }
    if (target.envUrl && String(target.envUrl).replace(/\/+$/, '').toLowerCase() !== String(env.url).replace(/\/+$/, '').toLowerCase()) {
      throw new D365Error(t('access.error.environmentChanged', { env: plan.envKey }), {
        code: 'environment-changed',
        hint: t('access.hint.environmentChanged', { planUrl: target.envUrl, currentUrl: env.url }),
      })
    }
  } catch (error) {
    await releasePlan(config, plan.id)
    throw error
  }

  const client = hooks.targetClient ?? makeClient(env, config)
  const results = []
  const failures = []

  try {
    await setPlanStatus(config, target.id, 'running', { startedAt: new Date().toISOString() })

    for (const operation of target.operations) {
      try {
        if (operation.type === 'AssociateRole') {
          const navigation = operation.principalKind === 'team' ? 'teamroles_association' : 'systemuserroles_association'
          await client.requestJson(client.buildUrl(`${operation.principalKind === 'team' ? 'teams' : 'systemusers'}(${operation.principalId})/${navigation}/$ref`), {
            method: 'POST',
            body: { '@odata.id': String(client.buildUrl(`${await entitySet(client, 'role', signal)}(${operation.roleId})`)) },
            capability: ACCESS_CAPABILITY,
            signal,
          })
        } else if (operation.type === 'DisassociateRole') {
          const navigation = operation.principalKind === 'team' ? 'teamroles_association' : 'systemuserroles_association'
          await client.requestJson(client.buildUrl(`${operation.principalKind === 'team' ? 'teams' : 'systemusers'}(${operation.principalId})/${navigation}(${operation.roleId})/$ref`), {
            method: 'DELETE',
            capability: ACCESS_CAPABILITY,
            signal,
          })
        } else if (operation.type === 'AddPrivileges') {
          await client.postJson('AddPrivilegesRole', {
            RoleId: operation.roleId,
            Privileges: [{ PrivilegeId: operation.privilegeId, Depth: operation.depth }],
          }, signal, ACCESS_CAPABILITY)
        } else if (operation.type === 'RemovePrivileges') {
          await client.postJson('RemovePrivilegeRole', {
            RoleId: operation.roleId,
            PrivilegeId: operation.privilegeId,
          }, signal, ACCESS_CAPABILITY)
        } else {
          throw new D365Error(t('access.error.badOperation', { operation: operation.type }), { code: 'bad-operation' })
        }
        results.push({ operation, ok: true })
      } catch (error) {
        failures.push({ operation, error: error instanceof Error ? error.message : String(error) })
      }
    }

    const ledger = await recordChange(config, {
      planId: target.id,
      kind: 'access',
      envKey: target.envKey,
      capability: ACCESS_CAPABILITY,
      operations: target.operations,
      applied: results,
      failed: failures,
      requestedBy: target.requestedBy,
      rationale: target.rationale,
    })

    // A partly failed plan ends as "failed" so it cannot be replayed silently;
    // the person cancels it or generates a new one after reading the ledger.
    await setPlanStatus(config, target.id, failures.length ? 'failed' : 'done', {
      finishedAt: new Date().toISOString(),
      appliedCount: results.length,
      failedCount: failures.length,
    }).catch(() => {})

    return { results, failures, ledger }
  } finally {
    await releasePlan(config, plan.id)
  }
}
