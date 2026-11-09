import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ownerIndexPath, readOwnerIndex } from '../lib/owner-index.js'

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-hub-owner-'))
process.env.DSH_HOME = tempHome

test.after(() => {
  fs.rmSync(tempHome, { recursive: true, force: true })
})

function writeOwnerFile(contents) {
  const file = ownerIndexPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents, 'utf8')
}

test('ownerIndexPath lives under DSH_HOME/storages/session-hub', () => {
  assert.equal(
    ownerIndexPath(),
    path.join(tempHome, 'storages', 'session-hub', 'owners.json'),
  )
})

test('readOwnerIndex returns an empty object when the file is missing', async () => {
  fs.rmSync(ownerIndexPath(), { force: true })
  assert.deepEqual(await readOwnerIndex(), {})
})

test('readOwnerIndex returns valid owner entries', async () => {
  writeOwnerFile(
    JSON.stringify({
      s1: { ownerSessionId: 'caller', createdAt: 1 },
      s2: { ownerSessionId: 'other' },
    }),
  )

  assert.deepEqual(await readOwnerIndex(), {
    s1: { ownerSessionId: 'caller', createdAt: 1 },
    s2: { ownerSessionId: 'other' },
  })
})

test('readOwnerIndex ignores malformed content and entries', async () => {
  writeOwnerFile('{not json')
  assert.deepEqual(await readOwnerIndex(), {})

  writeOwnerFile(JSON.stringify(['not', 'an', 'object']))
  assert.deepEqual(await readOwnerIndex(), {})

  writeOwnerFile(JSON.stringify({ s1: 'nope', s2: { ownerSessionId: '' } }))
  assert.deepEqual(await readOwnerIndex(), {})
})
