import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'

import { ownerIndexPath, readOwnerIndex, recordOwner } from '../src/host/owner-index.js'
import { createTempHome, removeTempHome } from './helpers/fixtures.js'

interface RawOwners {
  readonly [sessionId: string]: { readonly ownerSessionId?: unknown; readonly createdAt?: unknown }
}

describe('owner index', () => {
  const tempHome = createTempHome('session-hub-owner-')

  beforeEach(() => {
    process.env.DSH_HOME = tempHome
  })

  after(() => {
    removeTempHome(tempHome)
  })

  function writeOwnerFile(contents: string): void {
    const file = ownerIndexPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, contents, 'utf8')
  }

  test('ownerIndexPath lives under DSH_HOME/storages/session-hub', () => {
    assert.equal(ownerIndexPath(), path.join(tempHome, 'storages', 'session-hub', 'owners.json'))
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

  test('recordOwner creates the directory and writes the entry atomically', async () => {
    fs.rmSync(path.dirname(ownerIndexPath()), { recursive: true, force: true })

    await recordOwner('new-session', 'caller')

    const raw = JSON.parse(fs.readFileSync(ownerIndexPath(), 'utf8')) as RawOwners
    assert.equal(raw['new-session']?.ownerSessionId, 'caller')
    assert.equal(typeof raw['new-session']?.createdAt, 'number')
    assert.deepEqual(fs.readdirSync(path.dirname(ownerIndexPath())), ['owners.json'])
  })

  test('recordOwner merges with existing entries', async () => {
    writeOwnerFile(JSON.stringify({ s1: { ownerSessionId: 'caller', createdAt: 1 } }))

    await recordOwner('s2', 'caller')

    const owners = await readOwnerIndex()
    assert.deepEqual(owners.s1, { ownerSessionId: 'caller', createdAt: 1 })
    assert.equal(owners.s2?.ownerSessionId, 'caller')
    assert.equal(typeof owners.s2?.createdAt, 'number')
  })

  test('recordOwner serializes concurrent writes without losing entries', async () => {
    fs.rmSync(path.dirname(ownerIndexPath()), { recursive: true, force: true })

    await Promise.all(Array.from({ length: 8 }, (_, index) => recordOwner(`s${index}`, 'caller')))

    const owners = await readOwnerIndex()
    assert.equal(Object.keys(owners).length, 8)
    for (let index = 0; index < 8; index += 1) {
      assert.equal(owners[`s${index}`]?.ownerSessionId, 'caller')
    }
    assert.deepEqual(fs.readdirSync(path.dirname(ownerIndexPath())), ['owners.json'])
  })

  test('recordOwner rejects empty ids instead of writing a corrupt entry', async () => {
    fs.rmSync(path.dirname(ownerIndexPath()), { recursive: true, force: true })

    await assert.rejects(() => recordOwner('', 'caller'), /sessionId and ownerSessionId are required/)
    await assert.rejects(() => recordOwner('s1', ''), /sessionId and ownerSessionId are required/)
    assert.deepEqual(await readOwnerIndex(), {})
  })
})
