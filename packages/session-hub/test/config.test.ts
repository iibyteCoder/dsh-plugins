import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { DEFAULT_PERMISSION_MODE, resolvePermissionMode } from '../src/config.js'
import { PermissionMode } from '../src/shared/enums.js'

describe('config', () => {
  test('permission mode defaults to permissive', () => {
    assert.equal(DEFAULT_PERMISSION_MODE, PermissionMode.Permissive)
    for (const config of [undefined, null, {}, { permissionMode: undefined }]) {
      assert.equal(resolvePermissionMode(config), PermissionMode.Permissive)
    }
  })

  test('the exact string "owned" selects owned mode', () => {
    assert.equal(resolvePermissionMode({ permissionMode: 'owned' }), PermissionMode.Owned)
  })

  test('the explicit "permissive" value stays permissive', () => {
    assert.equal(resolvePermissionMode({ permissionMode: 'permissive' }), PermissionMode.Permissive)
  })

  test('invalid permission mode values fall back to permissive', () => {
    const invalid: readonly unknown[] = ['admin', 'OWNED', 'Owned', ' owned ', 'owned ', true, 1, {}, []]
    for (const permissionMode of invalid) {
      assert.equal(
        resolvePermissionMode({ permissionMode }),
        PermissionMode.Permissive,
        `expected ${JSON.stringify(permissionMode)} to fall back to permissive`,
      )
    }
  })

  test('only the permissionMode field is read from the config', () => {
    assert.equal(resolvePermissionMode({ permissionMode: 'owned', extra: true }), PermissionMode.Owned)
    assert.equal(resolvePermissionMode({ owned: true }), PermissionMode.Permissive)
  })
})
