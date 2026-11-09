import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const patch = readFileSync(patchPath, 'utf8')

test('declares the bundle patch in the manifest', () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
})

test('ships a non-empty patch file', () => {
  assert.ok(statSync(patchPath).isFile())
  assert.ok(patch.trim().length > 0)
})

test('inserts the plugin row instead of updating an existing entry', () => {
  // A bare `- id: ...` patch targets an existing row and is skipped with
  // `patch: entry "..." not found` when the bundle is loaded into a profile.
  assert.match(patch, /^- insert:\s*$/m)
  assert.doesNotMatch(patch, /^- id:\s*tool-session-hub\s*$/m)
})

test('inserts the tool-session-hub row for dsh-session-hub', () => {
  assert.match(patch, /^\s*- id:\s*tool-session-hub\s*$/m)
  assert.match(patch, /^\s*name:\s*dsh-session-hub\s*$/m)
})

test('keeps the patch file well formed', () => {
  assert.ok(patch.endsWith('\n'))
  assert.ok(!patch.includes('\t'))
  assert.ok(!patch.includes('\r'))
})
