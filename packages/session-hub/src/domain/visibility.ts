/**
 * Session visibility for the read tools.
 *
 * `scope` and `filters` are two independent narrowing rules that every read
 * path (`session_list`, `session_get`, `session_search`) shares:
 *
 * - `scope` limits by the caller's relationship to a session;
 * - `filters` are explicit opaque allow/deny lists from the profile config.
 *
 * Deny always wins. An allow list can only keep sessions in; it never grants
 * access that `scope` denies. Workspaces match by id, case-insensitive title,
 * or normalized path — the same rule the `workspace` argument uses.
 */
import type { ResolvedFilters, ScopePolicy } from '../config/resolve.js'
import type { WorkspaceSummary } from '../host/contracts.js'
import { cwdKey, isWithinPath, matchesWorkspace } from '../host/session-access.js'

/** The caller-side facts that decide visibility. */
export interface VisibilityRules {
  readonly scope: ScopePolicy
  readonly callerId: string
  /** Normalized comparison key of the caller cwd; `''` when unknown. */
  readonly callerCwdKey: string
  readonly filters: ResolvedFilters
}

/** One session as far as visibility is concerned. */
export interface VisibleSession {
  readonly sessionId: string
  readonly ownerId: string
  readonly cwd: string
  readonly workspace?: WorkspaceSummary | undefined
}

/** True when an allow list is configured for any dimension. */
export function hasAllowLists(filters: ResolvedFilters): boolean {
  return filters.allowSessions.length > 0 || filters.allowWorkspaces.length > 0
}

/** True when any allow/deny list is configured. */
export function hasAnyFilter(filters: ResolvedFilters): boolean {
  return (
    hasAllowLists(filters) ||
    filters.denySessions.length > 0 ||
    filters.denyWorkspaces.length > 0
  )
}

/** True when a workspace matches any of the opaque needles. */
export function matchesAllowList(
  workspace: WorkspaceSummary,
  needles: readonly string[],
): boolean {
  return needles.some((needle) => matchesWorkspace(workspace, needle))
}

/** Decide whether one session is visible to the caller. */
export function isSessionVisible(session: VisibleSession, rules: VisibilityRules): boolean {
  const { sessionId, ownerId, cwd, workspace } = session
  const { filters } = rules

  // Deny first: a denied session can never be re-admitted by an allow list.
  if (filters.denySessions.includes(sessionId)) return false
  if (workspace !== undefined && matchesAllowList(workspace, filters.denyWorkspaces)) return false

  // An allow list is a filter, never a grant: it must also satisfy `scope`.
  if (hasAllowLists(filters)) {
    const allowedBySession = filters.allowSessions.includes(sessionId)
    const allowedByWorkspace =
      workspace !== undefined && matchesAllowList(workspace, filters.allowWorkspaces)
    if (!allowedBySession && !allowedByWorkspace) return false
  }

  return passesScope(cwd, ownerId, rules)
}

function passesScope(cwd: string, ownerId: string, rules: VisibilityRules): boolean {
  switch (rules.scope) {
    case 'all':
      return true
    case 'owned':
      return rules.callerId !== '' && ownerId === rules.callerId
    case 'workspace':
      return rules.callerCwdKey !== '' && cwdKey(cwd) === rules.callerCwdKey
  }
}

/**
 * True when `cwd` lives inside one of the allowed workspaces.
 *
 * Used by `session_create.workspace: "allowlist"`, where the target may be a
 * plain cwd rather than a workspace reference: the directory then has to fall
 * inside a workspace named by `filters.allowWorkspaces`.
 */
export function isCwdAllowed(
  cwd: string,
  allowed: readonly string[],
  workspaces: readonly WorkspaceSummary[],
): boolean {
  const key = cwdKey(cwd)
  if (key === '') return false

  for (const needle of allowed) {
    const needleKey = cwdKey(needle)
    if (needleKey !== '' && isWithinPath(key, needleKey)) return true
    const workspace = workspaces.find((candidate) => matchesWorkspace(candidate, needle))
    const root = cwdKey(workspace?.path)
    if (root !== '' && isWithinPath(key, root)) return true
  }
  return false
}
