import assert from 'node:assert/strict'

// Keep in sync with the keyword whitelist enforced by the DSH host at
// `ctx.tools.register`. Anything outside this subset is rejected at runtime.
export const SUPPORTED_KEYWORDS = new Set<string>([
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

export const SUPPORTED_TYPES = new Set<string>([
  'object',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
  'array',
])

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Recursively assert that every node of a JSON Schema stays inside the subset
 * the DSH host understands.
 */
export function assertSupportedSchema(schema: unknown, location: string): void {
  assert.ok(isPlainObject(schema), `${location}: schema node must be an object`)

  for (const [keyword, value] of Object.entries(schema)) {
    assert.ok(SUPPORTED_KEYWORDS.has(keyword), `${location}: unsupported keyword "${keyword}"`)

    if (keyword === 'type') {
      assert.ok(
        typeof value === 'string' && SUPPORTED_TYPES.has(value),
        `${location}.type: unsupported type "${String(value)}"`,
      )
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
      assert.ok(
        Array.isArray(value) && value.length > 0,
        `${location}.oneOf: must be a non-empty array`,
      )
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
