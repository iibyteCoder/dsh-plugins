/**
 * Ownership rules shared by every mutating tool.
 *
 * Ownership lives in the plugin's own index (`host/owner-index.ts`); the host
 * services are only an execution surface. Keeping the rules in one module
 * means `session_update`, `session_close` and the messaging tools cannot drift
 * apart on who may act on a session.
 */
import type { ConfirmPolicy, TargetPolicy } from '../config/resolve.js'
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

/** True when the caller created the target (and both ids are usable). */
export function ownedByCaller(ownerId: string, callerId: string): boolean {
  const owner = nonEmptyString(ownerId)
  const caller = nonEmptyString(callerId)
  return owner !== '' && owner === caller
}

/**
 * Decide whether `targets` permits acting on a session.
 *
 * `owned` restricts every target to sessions the caller created; `any` applies
 * no ownership restriction. Only "the caller created this target" can satisfy
 * `owned` — unknown ownership is treated as not owned.
 */
export function targetAllowed(ownerId: string, callerId: string, targets: TargetPolicy): boolean {
  return targets === 'any' || ownedByCaller(ownerId, callerId)
}

/**
 * Decide whether an operation on a target session needs explicit confirmation.
 *
 * - `never`: no confirmation is ever required;
 * - `non-owned`: required unless the caller created the target;
 * - `always`: required even for the caller's own sessions.
 */
export function confirmRequiredBy(
  ownerId: string,
  callerId: string,
  confirm: ConfirmPolicy,
): boolean {
  if (confirm === 'never') return false
  if (confirm === 'always') return true
  return !ownedByCaller(ownerId, callerId)
}

/** Fixed authorization failure text shared by the mutating tools. */
export function confirmError(sessionId: string): string {
  return sessionHubError(
    ErrorCode.ConfirmRequired,
    `session "${sessionId}" is not owned by the calling session`,
  )
}

/** Fixed `targets: owned` failure text shared by the mutating tools. */
export function targetNotAllowedError(sessionId: string): string {
  return sessionHubError(
    ErrorCode.TargetNotAllowed,
    `session "${sessionId}" is not owned by the calling session`,
  )
}
