import test from 'node:test'
import assert from 'node:assert/strict'

import { createSessionCreateTool } from '../lib/tools/create.js'
import { createManageTools } from '../lib/tools/manage.js'
import { createReadTools } from '../lib/tools/read.js'
import { createSendTools } from '../lib/tools/send.js'
import { assertSupportedSchema, isPlainObject } from './helpers/schema-guard.js'

const ctx = { tools: { register() {} } }
const permissionModes = ['permissive', 'owned']

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
]

/**
 * @param {'permissive' | 'owned'} permissionMode
 * @returns {object[]}
 */
function buildTools(permissionMode) {
  return [
    ...createReadTools(ctx, { permissionMode }),
    createSessionCreateTool(ctx, { permissionMode }),
    ...createManageTools(ctx, { permissionMode }),
    ...createSendTools(ctx, { permissionMode }),
  ]
}

const toolsFor = new Map(permissionModes.map((mode) => [mode, buildTools(mode)]))
const tools = toolsFor.get('permissive')

/**
 * @param {string} toolName
 * @param {'permissive' | 'owned'} [permissionMode]
 * @returns {object}
 */
function toolByName(toolName, permissionMode = 'permissive') {
  const tool = toolsFor.get(permissionMode).find((candidate) => candidate.name === toolName)
  assert.ok(tool !== undefined, `missing tool "${toolName}" (${permissionMode})`)
  return tool
}

test('registered tools expose the expected names in both modes', () => {
  for (const permissionMode of permissionModes) {
    assert.deepEqual(
      toolsFor.get(permissionMode).map((tool) => tool.name),
      EXPECTED_TOOL_NAMES,
      `unexpected tool list in ${permissionMode} mode`,
    )
  }
})

test('parameter schemas only use supported keywords in both modes', () => {
  for (const permissionMode of permissionModes) {
    for (const tool of toolsFor.get(permissionMode)) {
      const label = `${tool.name} (${permissionMode})`
      assertSupportedSchema(tool.parameters, `${label}.parameters`)
      for (const [name, schema] of Object.entries(tool.parameters.properties)) {
        assert.equal('minimum' in schema, false, `${label}.${name}: "minimum" is not supported`)
        assert.equal('maximum' in schema, false, `${label}.${name}: "maximum" is not supported`)
      }
    }
  }
})

test('output schemas only use supported keywords in both modes', () => {
  for (const permissionMode of permissionModes) {
    for (const tool of toolsFor.get(permissionMode)) {
      const label = `${tool.name} (${permissionMode})`
      assert.ok(isPlainObject(tool.output), `${label}.output: must be an object`)
      assertSupportedSchema(tool.output.schema, `${label}.output.schema`)
    }
  }
})

test('session_create only takes an optional target plus the required message', () => {
  const parameters = toolByName('session_create').parameters

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
  const limit = toolByName('session_list').parameters.properties.limit
  const includeRecent = toolByName('session_get').parameters.properties.include_recent
  const timeoutMs = toolByName('session_wait').parameters.properties.timeout_ms

  for (const [label, schema] of [
    ['session_list.limit', limit],
    ['session_get.include_recent', includeRecent],
    ['session_wait.timeout_ms', timeoutMs],
  ]) {
    assert.equal('minimum' in schema, false, `${label}: "minimum" is not supported by the host`)
    assert.equal('maximum' in schema, false, `${label}: "maximum" is not supported by the host`)
  }
})

test('numeric options keep their type, description and default', () => {
  const limit = toolByName('session_list').parameters.properties.limit

  assert.equal(limit.type, 'integer')
  assert.equal(limit.default, 30)
  assert.match(limit.description, /default 30, max 200/)
})

test('status filter keeps its enum values and default', () => {
  const status = toolByName('session_list').parameters.properties.status

  assert.equal(status.type, 'string')
  assert.deepEqual(status.enum, ['running', 'idle', 'blank', 'archived', 'all'])
  assert.equal(status.default, 'all')
})

test('session_send only declares a target and a message', () => {
  const parameters = toolByName('session_send').parameters

  assert.deepEqual(parameters.required, ['session_id', 'message'])
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['message', 'session_id'])
})

test('session_wake only declares a target and a message', () => {
  const parameters = toolByName('session_wake').parameters

  assert.deepEqual(parameters.required, ['session_id', 'message'])
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['message', 'session_id'])
})

test('session_wait requires a session id and declares a bounded timeout', () => {
  const parameters = toolByName('session_wait').parameters

  assert.deepEqual(parameters.required, ['session_id'])
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['session_id', 'timeout_ms'])
  assert.equal(parameters.properties.timeout_ms.type, 'integer')
  assert.equal(parameters.properties.timeout_ms.default, 120000)
  assert.match(parameters.properties.timeout_ms.description, /1000\.\.600000/)
})

test('confirm only exists in the owned send and wake schemas', () => {
  for (const permissionMode of permissionModes) {
    const expected = permissionMode === 'owned'
    for (const toolName of ['session_send', 'session_wake']) {
      const properties = toolByName(toolName, permissionMode).parameters.properties
      assert.equal(
        'confirm' in properties,
        expected,
        `${toolName} (${permissionMode}): confirm mismatch`,
      )
      if (expected) assert.equal(properties.confirm.type, 'boolean')
    }

    // Waiting is read-only and never asks for confirmation.
    assert.equal(
      'confirm' in toolByName('session_wait', permissionMode).parameters.properties,
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
