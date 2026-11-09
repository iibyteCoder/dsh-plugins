/**
 * The plugin-owned ownership index.
 *
 * Ownership lives in a small JSON document under `DSH_HOME`, not in host
 * state, so it survives restarts and profile changes. Reads are best-effort
 * (a missing or malformed file means "no ownership recorded"); writes are
 * serialized in-process and committed atomically.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { sessionHubText } from '../shared/errors.js'
import type { OwnerIndex, OwnerRecord } from '../shared/types.js'

/** Absolute path of the owner index file. */
export function ownerIndexPath(): string {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'session-hub', 'owners.json')
}

/**
 * Read the owner index.
 *
 * Shape: `{ [sessionId]: { ownerSessionId, createdAt } }`. A missing,
 * unreadable, or malformed file yields an empty index instead of throwing,
 * because this is a best-effort read-only enrichment.
 */
export async function readOwnerIndex(): Promise<OwnerIndex> {
  let raw: string
  try {
    raw = await fs.readFile(ownerIndexPath(), 'utf8')
  } catch {
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

  const owners: Record<string, OwnerRecord> = {}
  for (const [sessionId, entry] of Object.entries(parsed)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const { ownerSessionId } = entry as { readonly ownerSessionId?: unknown }
    if (typeof ownerSessionId !== 'string' || ownerSessionId === '') continue
    owners[sessionId] = { ...entry, ownerSessionId } as OwnerRecord
  }
  return owners
}

// Tail of the in-process write queue. Every recordOwner() call appends its
// read-modify-write cycle here, so two concurrent creates cannot both read the
// same snapshot and then overwrite each other's entry.
let writeQueue: Promise<void> = Promise.resolve()

/**
 * Record which session created another session.
 *
 * Reads the current index, merges the entry and writes the whole document
 * back. Writes are serialized inside this process and committed with a
 * temp-file + rename, so an interrupted write cannot leave a half-written
 * `owners.json` behind.
 */
export function recordOwner(sessionId: string, ownerSessionId: string): Promise<void> {
  const target = typeof sessionId === 'string' ? sessionId.trim() : ''
  const owner = typeof ownerSessionId === 'string' ? ownerSessionId.trim() : ''
  if (target === '' || owner === '') {
    return Promise.reject(
      new Error(sessionHubText('sessionId and ownerSessionId are required to record ownership')),
    )
  }

  const write = (): Promise<void> => updateOwnerIndex(target, owner)
  const result = writeQueue.then(write, write)
  // Keep the queue usable after a failed write; the failure itself is reported
  // to the caller through `result`.
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

async function updateOwnerIndex(sessionId: string, ownerSessionId: string): Promise<void> {
  const owners: Record<string, OwnerRecord> = { ...(await readOwnerIndex()) }
  owners[sessionId] = { ownerSessionId, createdAt: Date.now() }
  await writeOwnerIndex(owners)
}

/**
 * Atomically replace the owner index with `owners`.
 */
async function writeOwnerIndex(owners: OwnerIndex): Promise<void> {
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

/** Short random fragment that keeps concurrent temp file names distinct. */
function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 10)
}
