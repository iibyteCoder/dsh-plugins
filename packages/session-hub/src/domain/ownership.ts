/**
 * Ownership rules shared by every mutating tool.
 *
 * Ownership lives in the plugin's own index (`host/owner-index.ts`); the host
 * services are only an execution surface. Keeping the rules in one module
 * means `session_update`, `session_close` and the messaging tools cannot drift
 * apart on who may act on a session.
 */
import { readOwnerIndex } from '../host/owner-index.js'
import { nonEmptyString } from '../shared/args.js'
import { ErrorCode } from '../shared/enums.js'
import { sessionHubError } from '../shared/errors.js'

/**
 * Read the owner session id of a session.
 *
 * A missing entry, a malformed entry, or an unusable input yields `''`, which
 * every caller treats as "not owned by the caller" — unknown ownership must
 * never silently grant permission.
 */
export async function ownerOf(sessionId: string): Promise<string> {
  const id = nonEmptyString(sessionId)
  if (id === '') return ''
  const owners = await readOwnerIndex()
  const owner = owners[id]?.ownerSessionId
  return typeof owner === 'string' ? owner : ''
}

/**
 * Decide whether an operation on a target session needs explicit confirmation.
 *
 * Unknown ownership, or ownership by a different session, always needs
 * confirmation. Only "the caller created this target" can be exempt; closing
 * the calling session itself is rejected before this check runs.
 */
export function confirmRequired(ownerId: string, callerId: string): boolean {
  const owner = nonEmptyString(ownerId)
  const caller = nonEmptyString(callerId)
  const ownedByCaller = owner !== '' && owner === caller
  return !ownedByCaller
}

/** Fixed authorization failure text shared by the mutating tools. */
export function confirmError(sessionId: string): string {
  return sessionHubError(
    ErrorCode.ConfirmRequired,
    `session "${sessionId}" is not owned by the calling session`,
  )
}
