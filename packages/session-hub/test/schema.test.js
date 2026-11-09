import test from 'node:test'
import assert from 'node:assert/strict'

import { createReadTools } from '../lib/tools/read.js'

// Keep in sync with the keyword whitelist enforced by the DSH host at
// `ctx.tools.register`. Anything outside this subset is rejected at runtime.
const SUPPORTED_KEYWORDS = new Set([
  // constraints
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  // annotations
  'description',
  'title',
  'default',
  'examples',
])

const SUPPORTED_TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'null', 'array'])

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Recursively assert that every node of a JSON Schema stays inside the subset
 * the DSH host understands.
 *
 * @param {unknown} schema - Schema node to inspect.
 * @param {string} location - Human readable path used in failure messages.
 * @returns {void}
 */
function assertSupportedSchema(schema, location) {
  assert.ok(isPlainObject(schema), `${location}: schema node must be an object`)

  for (const [keyword, value] of Object.entries(schema)) {
    assert.ok(SUPPORTED_KEYWORDS.has(keyword), `${location}: unsupported keyword "${keyword}"`)

    if (keyword === 'type') {
      assert.ok(SUPPORTED_TYPES.has(value), `${location}.type: unsupported type "${String(value)}"`)
    }

    if (keyword === 'properties') {
      assert.ok(isPlainObject(value), `${location}.properties: must be an object`)
      for (const [name, child] of Object.entries(value)) {
        assertSupportedSchema(child, `${location}.properties.${name}`)
      }
    }

    if (keyword === 'items') {
      assertSupportedSchema(value, `${location}.items`)
    }

    if (keyword === 'oneOf') {
      assert.ok(Array.isArray(value) && value.length > 0, `${location}.oneOf: must be a non-empty array`)
      value.forEach((child, index) => {
        assertSupportedSchema(child, `${location}.oneOf[${index}]`)
      })
    }

    if (keyword === 'additionalProperties') {
      assert.ok(
        typeof value === 'boolean' || isPlainObject(value),
        `${location}.additionalProperties: must be a boolean or a schema object`,
      )
      if (isPlainObject(value)) {
        assertSupportedSchema(value, `${location}.additionalProperties`)
      }
    }
  }
}

const ctx = { tools: { register() {} } }
const tools = createReadTools(ctx)

function toolByName(toolName) {
  const tool = tools.find((candidate) => candidate.name === toolName)
  assert.ok(tool !== undefined, `missing tool "${toolName}"`)
  return tool
}

test('read-only tools expose the expected names', () => {
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['session_list', 'session_get'],
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
