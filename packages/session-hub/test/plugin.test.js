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
