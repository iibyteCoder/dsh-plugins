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

function register(config) {
  const registered = []
  apply({ tools: { register: (tool) => registered.push(tool) } }, config)
  return registered
}

test('apply registers the read, create, manage and send tools', () => {
  const registered = register()

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

test('apply defaults to the permissive manage schemas', () => {
  const registered = register()
  const byName = (name) => registered.find((tool) => tool.name === name)

  assert.equal('confirm' in byName('session_update').parameters.properties, false)
  assert.equal('confirm' in byName('session_close').parameters.properties, false)
})

test('apply registers the owned manage schemas when permissionMode is "owned"', () => {
  const registered = register({ permissionMode: 'owned' })
  const byName = (name) => registered.find((tool) => tool.name === name)

  assert.equal(byName('session_update').parameters.properties.confirm.type, 'boolean')
  assert.equal(byName('session_close').parameters.properties.confirm.type, 'boolean')
})

test('apply treats an invalid permissionMode as permissive', () => {
  for (const permissionMode of ['OWNED', 'admin', true]) {
    const registered = register({ permissionMode })
    const update = registered.find((tool) => tool.name === 'session_update')
    const close = registered.find((tool) => tool.name === 'session_close')

    assert.equal('confirm' in update.parameters.properties, false)
    assert.equal('confirm' in close.parameters.properties, false)
  }
})
