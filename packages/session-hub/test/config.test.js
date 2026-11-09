import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_PERMISSION_MODE, resolvePermissionMode } from '../lib/config.js'

test('permission mode defaults to permissive', () => {
  assert.equal(DEFAULT_PERMISSION_MODE, 'permissive')
  for (const config of [undefined, null, {}, { permissionMode: undefined }]) {
    assert.equal(resolvePermissionMode(config), 'permissive')
  }
})

test('the exact string "owned" selects owned mode', () => {
  assert.equal(resolvePermissionMode({ permissionMode: 'owned' }), 'owned')
})

test('the explicit "permissive" value stays permissive', () => {
  assert.equal(resolvePermissionMode({ permissionMode: 'permissive' }), 'permissive')
})

test('invalid permission mode values fall back to permissive', () => {
  for (const permissionMode of ['admin', 'OWNED', 'Owned', ' owned ', 'owned ', true, 1, {}, []]) {
    assert.equal(
      resolvePermissionMode({ permissionMode }),
      'permissive',
      `expected ${JSON.stringify(permissionMode)} to fall back to permissive`,
    )
  }
})

test('only the permissionMode field is read from the config', () => {
  assert.equal(resolvePermissionMode({ permissionMode: 'owned', extra: true }), 'owned')
  assert.equal(resolvePermissionMode({ owned: true }), 'permissive')
})
