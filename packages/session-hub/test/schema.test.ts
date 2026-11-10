import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { ResolvedSettings } from '../src/config/resolve.js'
import { createSessionCreateTool } from '../src/tools/create.js'
import { createManageTools } from '../src/tools/manage.js'
import { createReadTools } from '../src/tools/read.js'
import { createSearchTool } from '../src/tools/search.js'
import { createSendTools } from '../src/tools/send.js'
import type { HostContext } from '../src/shared/types.js'
import { serviceContext, toolByName as findTool } from './helpers/fixtures.js'
import { assertSupportedSchema, isPlainObject } from './helpers/schema-guard.js'
import { createSettings } from './helpers/settings.js'

const ctx: HostContext = serviceContext({})

const EXPECTED_TOOL_NAMES = [
  'session_list',
  'session_get',
  'session_create',
  'session_update',
  'session_close',
  'session_open',
  'session_send',
  'session_wake',
  'session_wait',
  'session_search',
]

const VARIANTS: readonly (readonly [string, ResolvedSettings])[] = [
  ['default', createSettings()],
  [
    'hardened',
    createSettings({
      session_list: { status: 'running', limit: 5 },
      session_get: { recent: 0 },
      session_search: { limit: 5 },
      session_create: { task: 'optional', allowTitle: false, allowModel: false },
      session_update: { targets: 'owned', confirm: 'non-owned' },
      session_close: { confirm: 'always' },
      session_open: { confirm: 'non-owned' },
      session_send: { confirm: 'non-owned', allowSelf: true },
      session_wake: { confirm: 'always', whenRunning: 'queue' },
      session_wait: { timeoutMaxMs: 5000, replyMaxChars: 500, confirm: 'non-owned' },
    }),
  ],
]

function buildTools(settings: ResolvedSettings): ToolDefinition[] {
  return [
    ...createReadTools(ctx, settings),
    createSessionCreateTool(ctx, settings),
    ...createManageTools(ctx, settings),
    ...createSendTools(ctx, settings),
    createSearchTool(ctx, settings),
  ]
}

const toolsFor = new Map<string, ToolDefinition[]>(
  VARIANTS.map(([label, settings]) => [label, buildTools(settings)]),
)

function toolsOf(label: string): ToolDefinition[] {
  return toolsFor.get(label) ?? []
}

function toolByName(toolName: string, label = 'default'): ToolDefinition {
  return findTool(toolsOf(label), toolName)
}

interface ToolParameters {
  readonly required: readonly string[]
  readonly properties: Record<string, Record<string, unknown>>
}

function parametersOf(tool: ToolDefinition): ToolParameters {
  return tool.parameters as unknown as ToolParameters
}

describe('tool schemas', () => {
  test('registered tools expose the expected names in every config', () => {
    for (const [label] of VARIANTS) {
      assert.deepEqual(
        toolsOf(label).map((tool) => tool.name),
        EXPECTED_TOOL_NAMES,
        `unexpected tool list in ${label} config`,
      )
    }
  })

  test('parameter schemas only use supported keywords in every config', () => {
    for (const [label] of VARIANTS) {
      for (const tool of toolsOf(label)) {
        const toolLabel = `${tool.name} (${label})`
        assertSupportedSchema(tool.parameters, `${toolLabel}.parameters`)
        for (const [name, schema] of Object.entries(parametersOf(tool).properties)) {
          assert.equal('minimum' in schema, false, `${toolLabel}.${name}: "minimum" is not supported`)
          assert.equal('maximum' in schema, false, `${toolLabel}.${name}: "maximum" is not supported`)
        }
      }
    }
  })

  test('output schemas only use supported keywords in every config', () => {
    for (const [label] of VARIANTS) {
      for (const tool of toolsOf(label)) {
        const toolLabel = `${tool.name} (${label})`
        assert.ok(isPlainObject(tool.output), `${toolLabel}.output: must be an object`)
        assertSupportedSchema(tool.output.schema, `${toolLabel}.output.schema`)
      }
    }
  })

  test('session_create only takes an optional target plus the required message', () => {
    const parameters = parametersOf(toolByName('session_create'))

    assert.deepEqual(parameters.required, ['message'])
    assert.deepEqual(Object.keys(parameters.properties).sort(), [
      'agent_preset',
      'cwd',
      'message',
      'model',
      'provider',
      'reasoning_effort',
      'title',
      'workspace',
    ])
    for (const [name, schema] of Object.entries(parameters.properties)) {
      assert.equal(schema.type, 'string', `session_create.${name}: expected type string`)
    }
    assert.equal('initial_message' in parameters.properties, false)
  })

  test('session_create reflects the optional-task and title/model policies', () => {
    const parameters = parametersOf(toolByName('session_create', 'hardened'))

    assert.deepEqual(parameters.required, [])
    assert.equal('title' in parameters.properties, false)
    assert.equal('model' in parameters.properties, false)
    assert.equal('provider' in parameters.properties, false)
    assert.equal('reasoning_effort' in parameters.properties, false)
  })

  test('numeric options do not rely on minimum or maximum', () => {
    const limit = parametersOf(toolByName('session_list')).properties.limit
    const includeRecent = parametersOf(toolByName('session_get')).properties.include_recent
    const timeoutMs = parametersOf(toolByName('session_wait')).properties.timeout_ms

    const entries: readonly (readonly [string, Record<string, unknown> | undefined])[] = [
      ['session_list.limit', limit],
      ['session_get.include_recent', includeRecent],
      ['session_wait.timeout_ms', timeoutMs],
    ]
    for (const [label, schema] of entries) {
      assert.ok(schema !== undefined)
      assert.equal('minimum' in schema, false, `${label}: "minimum" is not supported by the host`)
      assert.equal('maximum' in schema, false, `${label}: "maximum" is not supported by the host`)
    }
  })

  test('numeric options keep their type, description and configured default', () => {
    const defaults = parametersOf(toolByName('session_list')).properties.limit
    const hardened = parametersOf(toolByName('session_list', 'hardened')).properties.limit

    assert.equal(defaults?.type, 'integer')
    assert.equal(defaults?.default, 30)
    assert.match(String(defaults?.description), /default 30, max 200/)
    assert.equal(hardened?.default, 5)
    assert.match(String(hardened?.description), /default 5, max 200/)
  })

  test('status filter keeps its enum values and the configured default', () => {
    const status = parametersOf(toolByName('session_list')).properties.status
    const hardened = parametersOf(toolByName('session_list', 'hardened')).properties.status

    assert.equal(status?.type, 'string')
    assert.deepEqual(status?.enum, ['running', 'idle', 'blank', 'archived', 'all'])
    assert.equal(status?.default, 'all')
    assert.equal(hardened?.default, 'running')
  })

  test('session_send only declares a target and a message by default', () => {
    const parameters = parametersOf(toolByName('session_send'))

    assert.deepEqual(parameters.required, ['session_id', 'message'])
    assert.deepEqual(Object.keys(parameters.properties).sort(), ['message', 'session_id'])
  })

  test('session_wake only declares a target and a message by default', () => {
    const parameters = parametersOf(toolByName('session_wake'))

    assert.deepEqual(parameters.required, ['session_id', 'message'])
    assert.deepEqual(Object.keys(parameters.properties).sort(), ['message', 'session_id'])
  })

  test('session_wait requires a session id and declares a bounded timeout', () => {
    const parameters = parametersOf(toolByName('session_wait'))

    assert.deepEqual(parameters.required, ['session_id'])
    assert.deepEqual(Object.keys(parameters.properties).sort(), ['session_id', 'timeout_ms'])
    assert.equal(parameters.properties.timeout_ms?.type, 'integer')
    assert.equal(parameters.properties.timeout_ms?.default, 120000)
    assert.match(String(parameters.properties.timeout_ms?.description), /1000\.\.120000/)
  })

  test('session_wait reflects the configured timeout default', () => {
    const parameters = parametersOf(toolByName('session_wait', 'hardened'))

    assert.equal(parameters.properties.timeout_ms?.default, 5000)
    assert.match(String(parameters.properties.timeout_ms?.description), /1000\.\.5000/)
  })

  test('confirm only exists where the policy can require it', () => {
    for (const toolName of ['session_send', 'session_wake', 'session_wait']) {
      assert.equal(
        'confirm' in parametersOf(toolByName(toolName)).properties,
        false,
        `${toolName} (default) must omit confirm`,
      )
      const confirm = parametersOf(toolByName(toolName, 'hardened')).properties.confirm as
        | { readonly type?: unknown }
        | undefined
      assert.equal(confirm?.type, 'boolean', `${toolName} (hardened) must declare confirm`)
    }

    for (const toolName of ['session_update', 'session_close', 'session_open']) {
      assert.equal('confirm' in parametersOf(toolByName(toolName)).properties, false)
      assert.equal(
        parametersOf(toolByName(toolName, 'hardened')).properties.confirm?.type,
        'boolean',
        `${toolName} (hardened)`,
      )
    }
  })

  test('session_interrupt is no longer registered', () => {
    assert.equal(
      toolsOf('default').some((tool) => tool.name === 'session_interrupt'),
      false,
    )
  })
})
