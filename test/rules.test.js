import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getPagedWithSelectFallback, retryDelay } from '../lib/client.js'
import { D365Error } from '../lib/errors.js'
import { compareVersion } from '../lib/contract.js'
import { claimMigrationPlan, deleteMigrationPlan, executeMigration, executeUpdate, ownerLookup, readMigrationPlan, releaseMigrationPlan, saveMigrationPlan } from '../lib/data-migrate.js'
import { parseMergeRequestUrl } from '../lib/gitlab.js'
import { redact } from '../lib/tool-trace.js'
import { keyedRows } from '../lib/resources.js'
import { recordKey } from '../lib/tool-data.js'
import { writeTotals } from '../lib/tool-data-sync.js'
import { artifactRoot, compareEnvironments, mapEnvironments, writeArtifact } from '../lib/runtime.js'
import { groupDurations, stageSteps } from '../lib/perf.js'
import { flattenActions } from '../lib/tool-flows.js'
import { scanLines } from '../lib/tool-reports.js'
import { ATTRIBUTE_TYPES } from '../lib/write-actions.js'
import { writeFile } from 'node:fs/promises'
import { resolveLocale, translate, withLocale } from '../lib/i18n.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

test('select fallback retries only with the rejected selected column removed', async () => {
  const requests = []
  const client = {
    async getPaged(path, params) {
      requests.push({ path, params: { ...params } })
      if (params.$select.includes('badcolumn')) {
        throw new D365Error("Could not find a property named 'badcolumn' on type 'X'", { status: 400 })
      }
      return { records: [{ name: 'ok' }], hasMore: false }
    },
  }
  const result = await getPagedWithSelectFallback(client, 'accounts', {
    $select: 'name,badcolumn',
    $filter: "name eq 'A'",
    $orderby: 'name',
  }, 5)
  assert.deepEqual(result.page.records, [{ name: 'ok' }])
  assert.equal(result.selectDropped, true)
  assert.deepEqual(result.droppedFields, ['badcolumn'])
  assert.equal(requests.length, 2)
  assert.equal(requests[1].params.$select, 'name')
  assert.equal(requests[1].params.$filter, "name eq 'A'")
  assert.equal(requests[1].params.$orderby, 'name')
})

test('select fallback never removes a missing property used outside select', async () => {
  const client = {
    async getPaged() {
      throw new D365Error("Could not find a property named 'missing' on type 'X'", { status: 400 })
    },
  }
  await assert.rejects(
    getPagedWithSelectFallback(client, 'accounts', { $select: 'name,missing', $filter: 'missing eq 1' }, 5),
    (error) => error.code === 'unknown-property',
  )
})

test('mapEnvironments bounds concurrency and preserves input order', async () => {
  let active = 0
  let peak = 0
  const items = [10, 20, 30, 40, 50]
  const results = await mapEnvironments(items, async (item, index) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, (items.length - index) * 2))
    active -= 1
    return item * 2
  }, 2)
  assert.equal(peak, 2)
  assert.deepEqual(results, [20, 40, 60, 80, 100])
})

test('writeArtifact stores compact JSON with one trailing newline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'd365-kit-'))
  try {
    const config = { workspaceDir: directory }
    const file = await writeArtifact(config, 'compact', { ok: true, rows: [{ id: 1 }] })
    const text = await readFile(file, 'utf8')
    assert.equal(text, '{"ok":true,"rows":[{"id":1}]}\n')
    assert.ok(file.startsWith(artifactRoot(config).replace(/\\/g, '/')))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('GitLab merge request URLs require a credential-free HTTPS origin', () => {
  assert.deepEqual(parseMergeRequestUrl('https://gitlab.example/g/p/-/merge_requests/42/diffs'), {
    base: 'https://gitlab.example', project: 'g/p', iid: '42',
  })
  assert.equal(parseMergeRequestUrl('http://gitlab.example/g/p/-/merge_requests/42'), null)
  assert.equal(parseMergeRequestUrl('https://token@gitlab.example/g/p/-/merge_requests/42'), null)
})

test('data plans allow exactly one atomic claimant', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'd365-kit-plan-'))
  try {
    const config = { workspaceDir: directory }
    const plan = await saveMigrationPlan(config, { kind: 'data-update', environment: 'dev', values: {} })
    assert.ok(await claimMigrationPlan(config, plan.id))
    await assert.rejects(claimMigrationPlan(config, plan.id), (error) => error.code === 'plan-busy')
    await releaseMigrationPlan(config, plan.id)
    assert.ok(await claimMigrationPlan(config, plan.id))
    await releaseMigrationPlan(config, plan.id)
    assert.equal((await readMigrationPlan(config, plan.id)).status, 'pending')
    await deleteMigrationPlan(config, plan.id)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('execution rejects an organization URL that changed after planning', async () => {
  const config = { environments: { dev: { url: 'https://new.crm.dynamics.com' }, sit: { url: 'https://sit.crm.dynamics.com' } }, settings: {} }
  await assert.rejects(executeUpdate(config, {
    id: 'plan', environment: 'dev', url: 'https://old.crm.dynamics.com', before: [], values: {},
  }, {}), (error) => error.code === 'environment-changed')
  await assert.rejects(executeMigration(config, {
    source: { key: 'dev', url: 'https://old.crm.dynamics.com' },
    target: { key: 'sit', url: 'https://sit.crm.dynamics.com' },
    options: {}, fields: [],
  }, {}, undefined, {}), (error) => error.code === 'environment-changed')
})

test('redaction masks quoted connection-string secrets', () => {
  const result = redact('Password="hello world"; Secret=\'a b\'; ClientSecret: "x y"')
  assert.ok(!result.text.includes('hello world'))
  assert.ok(!result.text.includes('a b'))
  assert.ok(!result.text.includes('x y'))
  assert.equal(result.count, 3)
  assert.equal(redact('Authorization: Bearer abc.def').count, 1)
})

test('flow default branches participate in table-reference scans', () => {
  const actions = { Switch: { type: 'Switch', default: { actions: { Fallback: { type: 'OpenApiConnection', inputs: { parameters: { entityName: 'account' } } } } } } }
  assert.deepEqual(flattenActions(actions).map((item) => item.path), ['Switch', 'Switch (default) > Fallback'])
})

test('incomplete comparisons are visibly marked', () => {
  const comparison = compareEnvironments('entities', [
    { env: { key: 'dev' }, rows: [{ LogicalName: 'account' }], hasMore: true },
    { env: { key: 'sit' }, rows: [{ LogicalName: 'account' }] },
  ])
  assert.deepEqual(comparison.incomplete, ['dev'])
  assert.match(comparison.lines[0], /incomplete/i)
})

test('decimal and money precision preserve explicit zero', () => {
  assert.equal(ATTRIBUTE_TYPES.decimal.extra({ precision: 0 }).Precision, 0)
  assert.equal(ATTRIBUTE_TYPES.money.extra({ precision: 0 }).Precision, 0)
})

test('performance parsing ignores missing durations and handles real day/fraction timestamps', () => {
  assert.equal(groupDurations([{ performanceexecutionduration: null }, { performanceexecutionduration: 7 }]).at(0).count, 1)
  const trace = 'Time Stamp:- 11/30/2026 23:59:59.9\nMessage:- A\nTime Stamp:- 12/02/2026 00:00:00.1\nMessage:- B\n06:10:25.1 C'
  const { steps } = stageSteps(trace)
  assert.equal(steps[0].delta, 86_400_200)
})

test('streamed long-line search finds a match beyond the retained prefix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'd365-kit-lines-'))
  const file = join(directory, 'long.json')
  try {
    await writeFile(file, 'x'.repeat(5000) + 'needle\n', 'utf8')
    const lines = []
    for await (const item of scanLines(file, 32, 'needle')) lines.push(item)
    assert.equal(lines[0].matched, true)
    assert.equal(lines[0].text.length, 32)
    assert.equal(lines[0].dropped, 4974)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Retry-After supports HTTP dates and numeric delay', () => {
  const numeric = { headers: new Map([['retry-after', '3']]) }
  numeric.headers.get = (key) => key === 'retry-after' ? '3' : null
  assert.equal(retryDelay(numeric, 1), 3000)
  const future = Date.now() + 5000
  const dated = { headers: { get: () => new Date(future).toUTCString() } }
  const delay = retryDelay(dated, 1)
  assert.ok(delay >= 3000 && delay <= 5000)
})

test('locale fallback is English and request locale is isolated concurrently', async () => {
  const key = 'runtime.cost'
  assert.equal(translate(key, { requests: 2, seconds: '1.0' }, 'zh'), '\uFF082 \u8BF7\u6C42 / 1.0s\uFF09')
  assert.equal(translate('missing.translation.key', undefined, 'zh'), 'missing.translation.key')
  assert.equal(translate('write.approve', undefined, 'zh'), '\u{6279}\u{51C6}\u{6267}\u{884C}')
  assert.match(translate('write.noOptions', { count: 3 }, 'zh'), /3/)
  assert.match(translate('perf.analysisFailed', { environment: 'dev' }, 'zh'), /dev/)
  assert.match(translate('snapshot.heading', { environments: 'dev / sit' }, 'zh'), /dev \/ sit/)
  const values = await Promise.all([
    withLocale('zh', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return [resolveLocale(), translate(key, { requests: 1, seconds: '0.1' })]
    }),
    withLocale('en', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return [resolveLocale(), translate(key, { requests: 1, seconds: '0.1' })]
    }),
  ])
  assert.deepEqual(values[0], ['zh', '\uFF081 \u8BF7\u6C42 / 0.1s\uFF09'])
  assert.deepEqual(values[1], ['en', '(1 requests / 0.1s)'])
})

test('a rejected query option is retried once without $top, then surfaced', async () => {
  const seen = []
  const client = {
    async getPaged(_path, params) {
      seen.push(params)
      throw new D365Error("The query parameter '$orderby' is not supported", { status: 400 })
    },
  }
  await assert.rejects(
    getPagedWithSelectFallback(client, 'accounts', { $select: 'name', $orderby: 'name' }, 5),
    (error) => error.code === 'unsupported-query-option',
  )
  // Metadata endpoints reject `$top`, so one retry drops only the page size.
  // `$orderby`/`$select` must survive it: dropping them answers another question.
  assert.equal(seen.length, 2)
  assert.deepEqual(seen[1], { $select: 'name', $orderby: 'name', __noTop: true })
})
