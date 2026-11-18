import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { bundledSkills } from '../lib/skill.js'

const root = fileURLToPath(new URL('..', import.meta.url))

const EXPECTED = [
  'd365_code_check',
  'd365_contract',
  'd365_data',
  'd365_data_sync',
  'd365_data_write',
  'd365_diagnose',
  'd365_diff',
  'd365_envs',
  'd365_flows',
  'd365_invoke',
  'd365_layers',
  'd365_metadata',
  'd365_metadata_write',
  'd365_migrate',
  'd365_refs',
  'd365_reports',
  'd365_roles',
  'd365_snapshot',
]

/** Collects what the plugin registers into a context that does nothing else. */
function fakeContext() {
  const tools = []
  const skills = []
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
    skills: { register: (skill) => { skills.push(skill); return () => {} } },
    inject: (_deps, callback) => { callback(ctx) },
    effect: (fn) => { const dispose = fn(); return () => dispose?.() },
    on() {},
    get(name) { return name === 'skills' ? ctx.skills : undefined },
  }
  return { ctx, tools, skills }
}

test('the plugin registers exactly the eighteen documented tools', async () => {
  const plugin = await import('../index.js')
  const { ctx, tools } = fakeContext()

  assert.equal(plugin.name, 'dsh-d365-kit')
  assert.deepEqual(plugin.inject, ['tools'])
  plugin.apply(ctx, {})

  assert.deepEqual(tools.map((tool) => tool.name).sort(), EXPECTED)
})

test('every tool describes itself and puts rules on the parameter', async () => {
  const plugin = await import('../index.js')
  const { ctx, tools } = fakeContext()
  plugin.apply(ctx, {})

  for (const tool of tools) {
    assert.ok(tool.description.length >= 60, `${tool.name} description is too short`)
    assert.equal(tool.parameters?.type, 'object', `${tool.name} has no object parameters`)

    const action = tool.parameters.properties?.action
    if (action?.enum) {
      const documented = [tool.description, action.description ?? ''].join('\n')
      for (const value of action.enum) {
        assert.ok(documented.includes(value), `${tool.name} does not document action ${value}`)
      }
    }
    for (const [name, property] of Object.entries(tool.parameters.properties ?? {})) {
      assert.ok(
        (property.description ?? '').length > 0,
        `${tool.name}.${name} has no description`,
      )
    }
  }
})

test('the tools that write say they need permission', async () => {
  const plugin = await import('../index.js')
  const { ctx, tools } = fakeContext()
  plugin.apply(ctx, {})

  const writes = tools.filter((tool) => /write|roles|data_sync/.test(tool.name))
  assert.ok(writes.length >= 4)
  for (const tool of writes) {
    assert.match(
      tool.description,
      /权限|授权|data\.(read|write)|message\.invoke|role\.admin/,
      `${tool.name} never says what it needs permission for`,
    )
  }
})

test('the packaged skills load, and no skill text names a removed tool', async () => {
  const skills = bundledSkills()
  assert.equal(skills.length, 2)
  const removed = ['d365_write', 'd365_sync', 'd365_access', 'd365_trace', 'd365_perf', 'd365_health', 'd365_configure']
  for (const skill of skills) {
    assert.ok(skill.name)
    assert.ok(skill.description)
    // The body routes the model to tools, so the body has to be checked too —
    // the description alone stayed clean while `perf.js` text went stale.
    for (const old of removed) {
      assert.ok(!new RegExp(`\\b${old}\\b`).test(skill.content ?? ''), `${skill.name} names ${old}`)
    }
  }

  const skillFiles = await readdir(join(root, 'skills'))
  assert.deepEqual(skillFiles.sort(), ['d365-changes', 'd365-troubleshooting'])
})

test('the locale files carry the same keys', async () => {
  const [en, zh] = await Promise.all(
    ['en', 'zh'].map(async (language) => JSON.parse(await readFile(join(root, 'locale', `${language}.json`), 'utf8'))),
  )
  const keys = (value, prefix = '') => Object.entries(value).flatMap(([key, child]) => (
    child && typeof child === 'object' && !Array.isArray(child)
      ? keys(child, `${prefix}${key}.`)
      : [`${prefix}${key}`]
  ))
  assert.deepEqual(keys(zh).sort(), keys(en).sort())
})

test('the browser half loads through the client module loader', async () => {
  const source = await readFile(join(root, 'client.js'), 'utf8')
  assert.ok(source.includes('__ModuleLoader__.load'))
  assert.ok(source.includes("id: 'dsh-d365-kit'"))
})

test('no source file still points at a removed tool name', async () => {
  const removed = ['d365_write', 'd365_sync', 'd365_access', 'd365_trace', 'd365_perf', 'd365_health', 'd365_configure']
  // Comments explain the rename (`(was d365_health)`), so they are allowed to
  // mention the old names; code, docs and skills are not.
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
      } else if (/\.(js|json|yml|md)$/.test(entry.name) && !/^CHANGELOG/.test(entry.name)) {
        files.push(path)
      }
    }
  }
  // `lib/` was never scanned before, which is how a stale `d365_health` hint
  // survived in `perf.js`.
  for (const directory of ['lib', 'skills', 'docs', 'locale', 'test']) await walk(join(root, directory))
  for (const file of await readdir(root, { withFileTypes: true })) {
    if (file.isFile() && /\.(js|json|yml|md)$/.test(file.name) && !/^CHANGELOG/.test(file.name)) files.push(join(root, file.name))
  }
  const self = join(root, 'test', 'surface.test.js')
  for (const file of files) {
    if (file === self) continue
    const source = strip(await readFile(file, 'utf8'))
    for (const old of removed) {
      assert.ok(!new RegExp(`\\b${old}\\b`).test(source), `${file} still mentions ${old}`)
    }
  }
})
