import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Absolute path of the owner index file.
 *
 * Resolved on every call (not at module load) so tests and diagnostics can
 * point `DSH_HOME` at a temporary directory.
 *
 * @returns {string}
 */
export function ownerIndexPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'session-hub', 'owners.json')
}

/**
 * Read the owner index.
 *
 * Shape: `{ [sessionId]: { ownerSessionId, createdAt } }`.
 * A missing, unreadable, or malformed file yields an empty object instead of
 * throwing, because this is a best-effort read-only enrichment.
 *
 * @returns {Promise<Record<string, {ownerSessionId: string, createdAt?: number|string}>>}
 */
export async function readOwnerIndex() {
  let raw
  try {
    raw = await fs.readFile(ownerIndexPath(), 'utf8')
  } catch {
    return {}
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

  const owners = {}
  for (const [sessionId, entry] of Object.entries(parsed)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const { ownerSessionId } = entry
    if (typeof ownerSessionId !== 'string' || ownerSessionId === '') continue
    owners[sessionId] = { ...entry, ownerSessionId }
  }
  return owners
}

// Tail of the in-process write queue. Every recordOwner() call appends its
// read-modify-write cycle here, so two concurrent creates cannot both read the
// same snapshot and then overwrite each other's entry.
let writeQueue = Promise.resolve()

/**
 * Record which session created another session.
 *
 * Reads the current index, merges `{ [sessionId]: { ownerSessionId, createdAt } }`
 * and writes the whole document back. Writes are serialized inside this process
 * and committed with a temp-file + rename, so an interrupted write cannot leave
 * a half-written `owners.json` behind.
 *
 * @param {string} sessionId - Session that was created.
 * @param {string} ownerSessionId - Session that created it.
 * @returns {Promise<void>}
 */
export function recordOwner(sessionId, ownerSessionId) {
  const target = typeof sessionId === 'string' ? sessionId.trim() : ''
  const owner = typeof ownerSessionId === 'string' ? ownerSessionId.trim() : ''
  if (target === '' || owner === '') {
    return Promise.reject(
      new Error('session-hub: sessionId and ownerSessionId are required to record ownership'),
    )
  }

  const write = () => updateOwnerIndex(target, owner)
  const result = writeQueue.then(write, write)
  // Keep the queue usable after a failed write; the failure itself is reported
  // to the caller through `result`.
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/**
 * @param {string} sessionId
 * @param {string} ownerSessionId
 * @returns {Promise<void>}
 */
async function updateOwnerIndex(sessionId, ownerSessionId) {
  const owners = await readOwnerIndex()
  owners[sessionId] = { ownerSessionId, createdAt: Date.now() }
  await writeOwnerIndex(owners)
}

/**
 * Atomically replace the owner index with `owners`.
 *
 * @param {Record<string, unknown>} owners
 * @returns {Promise<void>}
 */
async function writeOwnerIndex(owners) {
  const file = ownerIndexPath()
  const directory = path.dirname(file)
  await fs.mkdir(directory, { recursive: true })

  const tempFile = path.join(
    directory,
    `${path.basename(file)}.${process.pid}.${Date.now()}.${randomSuffix()}.tmp`,
  )
  try {
    await fs.writeFile(tempFile, `${JSON.stringify(owners, null, 2)}\n`, 'utf8')
    await fs.rename(tempFile, file)
  } catch (error) {
    await fs.rm(tempFile, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Short random fragment that keeps concurrent temp file names distinct even
 * within the same millisecond.
 *
 * @returns {string}
 */
function randomSuffix() {
  return Math.random().toString(16).slice(2, 10)
}
