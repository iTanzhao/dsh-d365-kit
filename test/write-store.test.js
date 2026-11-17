import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  changesDir,
  claimPlan,
  createPlan,
  listChanges,
  readPlan,
  recordChange,
  releasePlan,
  setPlanStatus,
  writePublishReport,
} from '../lib/write-store.js'

async function tempConfig() {
  return { workspaceDir: await mkdtemp(join(tmpdir(), 'd365-store-')) }
}

test('createPlan stores a pending plan that readPlan returns', async () => {
  const config = await tempConfig()
  const plan = await createPlan(config, {
    kind: 'metadata',
    envKey: 'dev',
    envUrl: 'https://dev.example.com',
    capability: 'attribute.add',
    title: 'add field',
    operations: [{ type: 'CreateAttribute' }],
  })
  assert.equal(typeof plan.id, 'string')
  assert.ok(plan.id.length >= 6)

  const stored = await readPlan(config, plan.id)
  assert.equal(stored.status, 'pending')
  assert.equal(stored.operations.length, 1)
})

test('claimPlan refuses a second claim until it is released', async () => {
  const config = await tempConfig()
  const plan = await createPlan(config, { title: 'x', operations: [] })

  await claimPlan(config, plan.id)
  await assert.rejects(() => claimPlan(config, plan.id), (error) => error.code === 'plan-busy')

  await releasePlan(config, plan.id)
  await claimPlan(config, plan.id)
  await releasePlan(config, plan.id)
})

test('claimPlan rejects an id that is not a plan id', async () => {
  const config = await tempConfig()
  await assert.rejects(() => claimPlan(config, '../escape'), (error) => error.code === 'bad-plan-id')
})

test('listChanges does not list publish sidecars', async () => {
  const config = await tempConfig()
  await recordChange(config, { planId: 'plan-a', status: 'done' })
  await writePublishReport(config, 'plan-a', { planId: 'plan-a', state: 'done' })

  const changes = await listChanges(config, 50)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].planId, 'plan-a')
})

test('recordChange reuses the path it is given', async () => {
  const config = await tempConfig()
  const path = await recordChange(config, { planId: 'plan-b', status: 'running' })
  await recordChange(config, { planId: 'plan-b', status: 'done' }, path)

  const files = (await readdir(changesDir(config))).filter((name) => name.endsWith('.json'))
  assert.equal(files.length, 1)
  const [entry] = await listChanges(config, 10)
  assert.equal(entry.status, 'done')
})

test('setPlanStatus moves the plan and refuses an unknown id', async () => {
  const config = await tempConfig()
  const plan = await createPlan(config, { title: 'x', operations: [] })

  const running = await setPlanStatus(config, plan.id, 'running', { startedAt: 'now' })
  assert.equal(running.status, 'running')
  assert.equal((await readPlan(config, plan.id)).status, 'running')

  assert.equal(await setPlanStatus(config, 'missing-plan', 'done'), undefined)
})
