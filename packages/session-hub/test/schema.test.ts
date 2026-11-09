import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { createSessionCreateTool } from '../src/tools/create.js'
import { createManageTools } from '../src/tools/manage.js'
import { createReadTools } from '../src/tools/read.js'
import { createSearchTool } from '../src/tools/search.js'
import { createSendTools } from '../src/tools/send.js'
import { PermissionMode } from '../src/shared/enums.js'
import type { HostContext } from '../src/shared/types.js'
import { serviceContext, toolByName as findTool } from './helpers/fixtures.js'
import { assertSupportedSchema, isPlainObject } from './helpers/schema-guard.js'

const ctx: HostContext = serviceContext({})
const permissionModes = [PermissionMode.Permissive, PermissionMode.Owned]

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

function buildTools(permissionMode: PermissionMode): ToolDefinition[] {
  return [
    ...createReadTools(ctx, { permissionMode }),
    createSessionCreateTool(ctx, { permissionMode }),
    ...createManageTools(ctx, { permissionMode }),
    ...createSendTools(ctx, { permissionMode }),
    createSearchTool(ctx, { permissionMode }),
  ]
}

const toolsFor = new Map<PermissionMode, ToolDefinition[]>(
  permissionModes.map((mode) => [mode, buildTools(mode)]),
)
const tools = toolsFor.get(PermissionMode.Permissive) ?? []

function toolByName(toolName: string, permissionMode: PermissionMode = PermissionMode.Permissive): ToolDefinition {
  const built = toolsFor.get(permissionMode) ?? []
  return findTool(built, toolName)
}

interface ToolParameters {
  readonly required: readonly string[]
  readonly properties: Record<string, Record<string, unknown>>
}

function parametersOf(tool: ToolDefinition): ToolParameters {
  return tool.parameters as unknown as ToolParameters
}

describe('tool schemas', () => {
  test('registered tools expose the expected names in both modes', () => {
    for (const permissionMode of permissionModes) {
      assert.deepEqual(
        (toolsFor.get(permissionMode) ?? []).map((tool) => tool.name),
        EXPECTED_TOOL_NAMES,
        `unexpected tool list in ${permissionMode} mode`,
      )
    }
  })

  test('parameter schemas only use supported keywords in both modes', () => {
    for (const permissionMode of permissionModes) {
      for (const tool of toolsFor.get(permissionMode) ?? []) {
        const label = `${tool.name} (${permissionMode})`
        assertSupportedSchema(tool.parameters, `${label}.parameters`)
        for (const [name, schema] of Object.entries(parametersOf(tool).properties)) {
          assert.equal('minimum' in schema, false, `${label}.${name}: "minimum" is not supported`)
          assert.equal('maximum' in schema, false, `${label}.${name}: "maximum" is not supported`)
        }
      }
    }
  })

  test('output schemas only use supported keywords in both modes', () => {
    for (const permissionMode of permissionModes) {
      for (const tool of toolsFor.get(permissionMode) ?? []) {
        const label = `${tool.name} (${permissionMode})`
        assert.ok(isPlainObject(tool.output), `${label}.output: must be an object`)
        assertSupportedSchema(tool.output.schema, `${label}.output.schema`)
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

  test('numeric options keep their type, description and default', () => {
    const limit = parametersOf(toolByName('session_list')).properties.limit

    assert.equal(limit?.type, 'integer')
    assert.equal(limit?.default, 30)
    assert.match(String(limit?.description), /default 30, max 200/)
  })

  test('status filter keeps its enum values and default', () => {
    const status = parametersOf(toolByName('session_list')).properties.status

    assert.equal(status?.type, 'string')
    assert.deepEqual(status?.enum, ['running', 'idle', 'blank', 'archived', 'all'])
    assert.equal(status?.default, 'all')
  })

  test('session_send only declares a target and a message', () => {
    const parameters = parametersOf(toolByName('session_send'))

    assert.deepEqual(parameters.required, ['session_id', 'message'])
    assert.deepEqual(Object.keys(parameters.properties).sort(), ['message', 'session_id'])
  })

  test('session_wake only declares a target and a message', () => {
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
    assert.match(String(parameters.properties.timeout_ms?.description), /1000\.\.600000/)
  })

  test('confirm only exists in the owned send and wake schemas', () => {
    for (const permissionMode of permissionModes) {
      const expected = permissionMode === PermissionMode.Owned
      for (const toolName of ['session_send', 'session_wake']) {
        const properties = parametersOf(toolByName(toolName, permissionMode)).properties
        assert.equal('confirm' in properties, expected, `${toolName} (${permissionMode}): confirm mismatch`)
        if (expected) {
          const confirm = properties.confirm as { readonly type?: unknown }
          assert.equal(confirm.type, 'boolean')
        }
      }

      // Waiting is read-only and never asks for confirmation.
      assert.equal(
        'confirm' in parametersOf(toolByName('session_wait', permissionMode)).properties,
        false,
        `session_wait (${permissionMode}) must omit confirm`,
      )
    }
  })

  test('session_interrupt is no longer registered', () => {
    assert.equal(
      tools.some((tool) => tool.name === 'session_interrupt'),
      false,
    )
  })
})
