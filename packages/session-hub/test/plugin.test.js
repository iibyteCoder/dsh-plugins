import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../lib/index.js'

test('declares plugin identity', () => {
  assert.equal(name, 'session-hub')
  assert.deepEqual(inject, ['tools'])
})

test('apply tolerates a context without tools', () => {
  assert.doesNotThrow(() => apply({}))
})

test('apply registers the read-only tools', () => {
  const registered = []
  apply({ tools: { register: (tool) => registered.push(tool) } })

  assert.deepEqual(registered.map((tool) => tool.name), ['session_list', 'session_get'])
  for (const tool of registered) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
})
