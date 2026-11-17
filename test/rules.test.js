import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareVersion } from '../lib/contract.js'
import { ownerLookup } from '../lib/data-migrate.js'
import { keyedRows } from '../lib/resources.js'
import { recordKey } from '../lib/tool-data.js'
import { writeTotals } from '../lib/tool-data-sync.js'

test('recordKey accepts a GUID', () => {
  const id = '11111111-2222-3333-4444-555555555555'
  assert.equal(recordKey(id), id)
  assert.equal(recordKey(`  ${id}  `), id)
})

test('recordKey accepts one alternate-key literal', () => {
  assert.equal(recordKey("contoso_code='001'"), "contoso_code='001'")
  assert.equal(recordKey("contoso_code='a b'"), "contoso_code='a b'")
})

test('recordKey rejects anything that can address another collection', () => {
  for (const value of ['contoso_001', 'accounts?$filter=1', 'a/../systemusers', "x='1' or 1=1", '', undefined]) {
    assert.throws(() => recordKey(value), (error) => error.code === 'bad-id', String(value))
  }
})

test('ownerLookup matches a team by name first and by email only when it is an address', () => {
  const team = ownerLookup('team', { name: 'Sales', emailaddress: 'sales@example.com' })
  assert.equal(team.set, 'teams')
  assert.equal(team.key, 'Sales')
  assert.deepEqual(team.filters, ["name eq 'Sales'", "emailaddress eq 'sales@example.com'"])

  const odd = ownerLookup('team', { name: 'Sales', emailaddress: 'not-an-address' })
  assert.deepEqual(odd.filters, ["name eq 'Sales'"])
})

test('ownerLookup for a user matches domain name or internal email', () => {
  const user = ownerLookup('user', { domainname: 'CONTOSO\\alice', internalemailaddress: 'alice@example.com' })
  assert.equal(user.set, 'systemusers')
  assert.equal(user.key, 'CONTOSO\\alice')
  assert.equal(user.filters.length, 1)
  assert.match(user.filters[0], /^domainname eq /)
})

test('ownerLookup escapes a quote in the name', () => {
  const team = ownerLookup('team', { name: "O'Brien" })
  assert.deepEqual(team.filters, ["name eq 'O''Brien'"])
})

test('keyedRows keeps same-named rows instead of dropping all but one', () => {
  const rows = [
    { name: 'Main', objecttypecode: 'account' },
    { name: 'Main', objecttypecode: 'contact' },
    { name: 'Main', objecttypecode: 'contact' },
  ]
  const map = keyedRows('forms', rows)
  assert.equal(map.size, 3)
  assert.ok(map.has('Main|account'))
  assert.ok(map.has('Main|contact'))
  assert.ok(map.has('Main|contact#2'))
})

test('compareVersion treats 1.0.0 and 1.0.0.0 as equal', () => {
  assert.equal(compareVersion('1.0.0', '1.0.0.0'), 0)
  assert.ok(compareVersion('1.0.0.0', '1.0.1.0') < 0)
  assert.ok(compareVersion('2.0.0.0', '1.9.9.9') > 0)
})

test('writeTotals never reports a negative write count', () => {
  const plan = { counts: { create: 3, conflict: 2, blocked: 5 } }
  assert.deepEqual(writeTotals(plan, { onMissingLookup: 'report' }), { created: 0, overwritten: 0, total: 0 })
  assert.deepEqual(writeTotals(plan, { onMissingLookup: 'null' }), { created: 3, overwritten: 0, total: 3 })
  assert.deepEqual(writeTotals(plan, { onMissingLookup: 'null', conflict: 'overwrite' }), {
    created: 3,
    overwritten: 2,
    total: 5,
  })
})
