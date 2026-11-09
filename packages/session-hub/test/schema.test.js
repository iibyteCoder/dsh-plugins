import test from 'node:test'
import assert from 'node:assert/strict'

import { createSessionCreateTool } from '../lib/tools/create.js'
import { createManageTools } from '../lib/tools/manage.js'
import { createReadTools } from '../lib/tools/read.js'
import { assertSupportedSchema, isPlainObject } from './helpers/schema-guard.js'

const ctx = { tools: { register() {} } }
const tools = [
  ...createReadTools(ctx),
  createSessionCreateTool(ctx),
  ...createManageTools(ctx),
]

function toolByName(toolName) {
  const tool = tools.find((candidate) => candidate.name === toolName)
  assert.ok(tool !== undefined, `missing tool "${toolName}"`)
  return tool
}

test('registered tools expose the expected names', () => {
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['session_list', 'session_get', 'session_create', 'session_update', 'session_close', 'session_open'],
  )
})

test('parameter schemas only use supported keywords', () => {
  for (const tool of tools) {
    assertSupportedSchema(tool.parameters, `${tool.name}.parameters`)
  }
})

test('output schemas only use supported keywords', () => {
  for (const tool of tools) {
    assert.ok(isPlainObject(tool.output), `${tool.name}.output: must be an object`)
    assertSupportedSchema(tool.output.schema, `${tool.name}.output.schema`)
  }
})

test('session_create parameters are optional strings', () => {
  const parameters = toolByName('session_create').parameters

  assert.deepEqual(parameters.required, [])
  assert.deepEqual(Object.keys(parameters.properties).sort(), [
    'agent_preset',
    'cwd',
    'model',
    'provider',
    'reasoning_effort',
    'title',
    'workspace',
  ])
  for (const [name, schema] of Object.entries(parameters.properties)) {
    assert.equal(schema.type, 'string', `session_create.${name}: expected type string`)
  }
})

test('numeric options do not rely on minimum or maximum', () => {
  const limit = toolByName('session_list').parameters.properties.limit
  const includeRecent = toolByName('session_get').parameters.properties.include_recent

  for (const [label, schema] of [
    ['session_list.limit', limit],
    ['session_get.include_recent', includeRecent],
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
