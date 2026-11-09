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

test('apply registers the read, create, manage and send tools', () => {
  const registered = []
  apply({ tools: { register: (tool) => registered.push(tool) } })

  assert.deepEqual(
    registered.map((tool) => tool.name),
    [
      'session_list',
      'session_get',
      'session_create',
      'session_update',
      'session_close',
      'session_open',
      'session_send',
      'session_interrupt',
    ],
  )
  for (const tool of registered) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
})
