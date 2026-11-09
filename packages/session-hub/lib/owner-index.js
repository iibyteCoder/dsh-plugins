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
