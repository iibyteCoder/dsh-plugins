/**
 * Target authorization shared by the mutating tools.
 *
 * Every tool checks the same three things in the same order — self-target,
 * `targets`, then `confirm` — so a policy can never mean one thing in
 * `session_send` and another in `session_close`. The caller supplies the
 * already-rendered self-error text because it differs per verb
 * (`SELF_TARGET` vs `SELF_CLOSE_FORBIDDEN`).
 */
import type { ConfirmPolicy, TargetPolicy } from '../config/resolve.js'
import {
  confirmError,
  confirmRequiredBy,
  ownerOf,
  targetAllowed,
  targetNotAllowedError,
} from './ownership.js'

/** Everything needed to authorize one target session. */
export interface TargetAuthorization {
  readonly sessionId: string
  readonly callerId: string
  readonly targets: TargetPolicy
  readonly confirm: ConfirmPolicy
  readonly allowSelf: boolean
  readonly confirmGiven: unknown
  /** Rendered failure used when `allowSelf` is false and the target is the caller. */
  readonly selfError: string
}

/** Authorization success: the target's recorded owner is `''` when unknown. */
export interface AuthorizedTargetInfo {
  readonly ownerId: string
}

/** Authorization failure, already rendered as outward text. */
export interface DeniedTargetInfo {
  readonly error: string
}

export type TargetAuthorizationResult = AuthorizedTargetInfo | DeniedTargetInfo

/** Check self-target, `targets` and `confirm` in that order. */
export async function authorizeTarget(
  authorization: TargetAuthorization,
): Promise<TargetAuthorizationResult> {
  const { sessionId, callerId, allowSelf, selfError, targets, confirm, confirmGiven } = authorization

  if (!allowSelf && callerId !== '' && sessionId === callerId) {
    return { error: selfError }
  }

  const ownerId = await ownerOf(sessionId)

  if (!targetAllowed(ownerId, callerId, targets)) {
    return { error: targetNotAllowedError(sessionId) }
  }

  // `confirm` only counts when it is the boolean true; "true", 1 and the like
  // must not be accepted as authorization.
  if (confirmRequiredBy(ownerId, callerId, confirm) && confirmGiven !== true) {
    return { error: confirmError(sessionId) }
  }

  return { ownerId }
}
