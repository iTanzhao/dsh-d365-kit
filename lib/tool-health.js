/**
 * `d365_health` — is the environment busy, what failed recently, what got
 * installed lately. Read-only; meant to be run before a release.
 */

import { loadConfig } from './config.js'
import { D365Error } from './errors.js'
import { readHealth, renderHealth } from './health.js'
import { writeArtifact } from './runtime.js'

function pickEnvironments(config, args) {
  const keys = Object.keys(config.environments)
  if (!keys.length) throw new D365Error('还没有配置任何 D365 环境', { hint: '在设置页「环境」里添加环境。' })
  if (args.allEnvironments === true) return keys
  if (Array.isArray(args.environments) && args.environments.length) {
    for (const key of args.environments) {
      if (!config.environments[key]) throw new D365Error(`未知环境：${key}`, { hint: `可用：${keys.join(', ')}` })
    }
    return args.environments
  }
  return [config.defaultEnvironment ?? keys[0]]
}

export function register(ctx, state) {
  const dispose = ctx.tools.register({
    name: 'd365_health',
    description:
      '环境健康检查：挂起/失败的后台作业、正在运行的导入发布、最近安装的解决方案与组织版本。只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        environments: {
          type: 'array',
          items: { type: 'string' },
          description: '环境 key 列表，省略则用默认环境。',
        },
        allEnvironments: { type: 'boolean', description: '对全部已配置环境执行同一查询。' },
        hours: { type: 'number', description: '失败作业的回看小时数，默认 24。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['schemaVersion', 'rows', 'artifactPath'],
        properties: {
          schemaVersion: { type: 'number' },
          artifactPath: { type: 'string' },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                env: { type: 'string' },
                url: { type: 'string' },
                version: { type: 'string' },
                organization: { type: 'string' },
                suspended: { type: 'number' },
                failed: { type: 'number' },
                hours: { type: 'number' },
                failures: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      name: { type: 'string' },
                      message: { type: 'string' },
                      operationtype: { type: 'number' },
                      modifiedon: { type: 'string' },
                      count: { type: 'number' },
                      errorcode: { type: 'number' },
                    },
                  },
                },
                runningSolutions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      name: { type: 'string' },
                      operation: { type: 'number' },
                      startedAt: { type: 'string' },
                      managed: { type: 'boolean' },
                    },
                  },
                },
                recentSolutions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      uniquename: { type: 'string' },
                      version: { type: 'string' },
                      managed: { type: 'boolean' },
                      installedon: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (args, value) => renderHealth(value.rows),
    },
    async execute(args, exec) {
      const config = await loadConfig(state.rawConfig)
      const keys = pickEnvironments(config, args)
      const rows = []
      for (const key of keys) {
        rows.push(await readHealth(config, key, { hours: args.hours, signal: exec.signal }))
      }
      const artifactPath = await writeArtifact(config, 'health', { generatedAt: new Date().toISOString(), rows })
      return { schemaVersion: 1, rows, artifactPath }
    },
  })
  return dispose
}
