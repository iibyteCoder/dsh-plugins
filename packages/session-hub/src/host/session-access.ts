/**
 * One read model of session state, shared by `session_list`, `session_get`,
 * `session_wait` and `session_search`.
 *
 * The host exposes several overlapping projections (listing rows, session
 * headers, live agents, archived ids). Keeping the precedence rules here
 * means the tools cannot disagree about whether a session is running,
 * archived or unknown.
 */
import path from 'node:path'

import { HostService, SessionEventKind, SessionStatus } from '../shared/enums.js'
import { errorMessage } from '../shared/errors.js'
import type { HostContext, SessionEventView } from '../shared/types.js'
import type {
  LiveSession,
  SessionController,
  SessionIdentity,
  SessionListValue,
  SessionObservation,
  SessionQueryService,
  SessionSummary,
  WorkspaceRegistry,
  WorkspaceSummary,
} from './contracts.js'
import type { HostServices } from './services.js'
import { readServices, serviceOf } from './services.js'

/** Absolute path, normalized, without trailing separators (case preserved). */
export function normalizeCwd(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return ''
  return stripTrailingSeparators(path.resolve(value.trim()))
}

/** Case-insensitive comparison key for a path. */
export function cwdKey(value: unknown): string {
  return normalizeCwd(value).toLowerCase()
}

/** True when `candidate` is `root` or lives below it; both are comparison keys. */
export function isWithinPath(candidate: string, root: string): boolean {
  if (candidate === root) return true
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  return candidate.startsWith(prefix)
}

function stripTrailingSeparators(resolved: string): string {
  const root = path.parse(resolved).root
  let value = resolved
  while (value.length > root.length && /[\\/]$/.test(value)) value = value.slice(0, -1)
  return value
}

/** Session id of a listing row or session header. */
export function sessionIdOf(item: SessionIdentity): string {
  const id = item.sessionId ?? item.id
  return typeof id === 'string' ? id : ''
}

export function sessionCwd(item: SessionSummary): string {
  const cwd = item.cwd ?? item.meta?.cwd
  return typeof cwd === 'string' ? cwd : ''
}

export function sessionTitle(item: SessionSummary): string {
  const title = item.projections?.values?.title ?? item.title
  return typeof title === 'string' ? title : ''
}

export function sessionModel(item: SessionSummary): string {
  const model = item.projections?.values?.modelSelection?.model
  return typeof model === 'string' ? model : ''
}

export function sessionUpdatedAt(item: SessionSummary): unknown {
  return item.updatedAt ?? item.projections?.values?.updatedAt ?? item.createdAt
}

/** The ids the workspace registry currently reports as archived. */
export function archivedSessionIds(registry: WorkspaceRegistry | undefined): string[] {
  const ids = registry?.archivedSessionIds
  if (!Array.isArray(ids)) return []
  return ids.filter((id): id is string => typeof id === 'string')
}

/** The archived ids of the current profile. */
export function readArchivedIds(ctx: HostContext): string[] {
  return archivedSessionIds(readServices(ctx).workspaces)
}

export function isArchived(registry: WorkspaceRegistry | undefined, id: string): boolean {
  const ids = registry?.archivedSessionIds
  return Array.isArray(ids) && ids.includes(id)
}

/** Load the workspace listing; failures degrade to "no workspaces". */
export async function loadWorkspaces(
  registry: WorkspaceRegistry | undefined,
): Promise<readonly WorkspaceSummary[]> {
  if (registry === undefined || registry === null || typeof registry.list !== 'function') return []
  try {
    const listed = await registry.list()
    return Array.isArray(listed) ? listed : []
  } catch {
    return []
  }
}

/** True when a workspace matches an id, case-insensitive title, or normalized path. */
export function matchesWorkspace(workspace: WorkspaceSummary, needle: string): boolean {
  if (typeof workspace.id === 'string' && workspace.id === needle) return true
  if (typeof workspace.title === 'string' && workspace.title.toLowerCase() === needle.toLowerCase()) {
    return true
  }
  const key = cwdKey(needle)
  return key !== '' && cwdKey(workspace.path) === key
}

/** Resolve a workspace argument against the current registry. */
export async function findWorkspace(
  ctx: HostContext,
  needle: string,
): Promise<WorkspaceSummary | null> {
  const registry = serviceOf(ctx, HostService.WorkspaceRegistry) as WorkspaceRegistry | undefined
  if (registry === undefined || registry === null || typeof registry.list !== 'function') return null

  let listed: readonly WorkspaceSummary[] | undefined
  try {
    listed = await registry.list()
  } catch {
    return null
  }

  const workspaces = Array.isArray(listed) ? listed : []
  const match = workspaces.find((workspace) => matchesWorkspace(workspace, needle))
  if (match === undefined || typeof match.id !== 'string' || match.id === '') return null
  return match
}

/** The workspace a session belongs to, falling back to path containment. */
export function workspaceForSession(
  item: SessionSummary,
  workspaces: readonly WorkspaceSummary[],
): WorkspaceSummary | undefined {
  const id = sessionIdOf(item)
  const cwd = cwdKey(sessionCwd(item))
  const workspaceId = item.workspaceId

  return workspaces.find((workspace) => {
    if (workspaceId !== undefined && workspace.id === workspaceId) return true
    if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(id)) return true
    const root = cwdKey(workspace.path)
    return cwd !== '' && root !== '' && isWithinPath(cwd, root)
  })
}

/** The host listing, normalized to an array. */
export async function listSessionItems(
  controller: SessionController,
): Promise<readonly SessionSummary[]> {
  const listing: SessionListValue | undefined = await controller.list({})
  const items = listing?.items
  return Array.isArray(items) ? (items as readonly SessionSummary[]) : []
}

/** Find one row in the host listing; a missing controller or a failure yields `undefined`. */
export async function findSessionItem(
  controller: SessionController | undefined,
  id: string,
): Promise<SessionSummary | undefined> {
  if (controller === undefined || typeof controller.list !== 'function') return undefined
  try {
    const items = await listSessionItems(controller)
    return items.find((item) => sessionIdOf(item) === id)
  } catch {
    return undefined
  }
}

/**
 * Session id → title projection.
 *
 * Search hits carry no title, so `session_search` completes them from this one
 * read model instead of inventing a second listing. A missing controller or a
 * failing listing yields an empty map: a title is enrichment, not a reason to
 * fail the search.
 */
export async function readSessionTitles(
  ctx: HostContext,
): Promise<ReadonlyMap<string, string>> {
  const controller = serviceOf(ctx, HostService.SessionController) as
    | SessionController
    | null
    | undefined
  if (controller === undefined || controller === null) return new Map()

  let items: readonly SessionSummary[]
  try {
    items = await listSessionItems(controller)
  } catch {
    return new Map()
  }

  const titles = new Map<string, string>()
  for (const item of items) {
    const id = sessionIdOf(item)
    if (id === '') continue
    const title = sessionTitle(item)
    if (title !== '') titles.set(id, title)
  }
  return titles
}

/** Status implied by a listing row, ignoring archiving. */
export function baseSessionStatus(item: SessionSummary): SessionStatus {
  if (item.running === true || item.status === SessionStatus.Running) return SessionStatus.Running
  if (item.blank === true || item.status === SessionStatus.Blank) return SessionStatus.Blank
  return SessionStatus.Idle
}

/** Status of a listing row, with the archived projection taking precedence. */
export function sessionStatus(item: SessionSummary, archived: ReadonlySet<string>): SessionStatus {
  return archived.has(sessionIdOf(item)) ? SessionStatus.Archived : baseSessionStatus(item)
}

function toSessionStatus(value: string): SessionStatus {
  switch (value) {
    case SessionStatus.Running:
      return SessionStatus.Running
    case SessionStatus.Idle:
      return SessionStatus.Idle
    case SessionStatus.Blank:
      return SessionStatus.Blank
    case SessionStatus.Archived:
      return SessionStatus.Archived
    default:
      return SessionStatus.Unknown
  }
}

function readAgentStatus(services: HostServices, id: string): string {
  try {
    const status: unknown = services.agents?.get?.(id)?.status
    return typeof status === 'string' ? status : ''
  } catch {
    return ''
  }
}

/** Resolve the status shown by `session_get`. */
export async function resolveSessionStatus(
  services: HostServices,
  controller: SessionController | undefined,
  id: string,
): Promise<SessionStatus> {
  if (isArchived(services.workspaces, id)) return SessionStatus.Archived

  const agentStatus = readAgentStatus(services, id)
  if (agentStatus !== '') return toSessionStatus(agentStatus)

  const item = await findSessionItem(controller, id)
  if (item !== undefined) return baseSessionStatus(item)
  return SessionStatus.Unknown
}

/** One exact read of a session: its durable header and committed events. */
export interface SessionSnapshot {
  readonly header: Record<string, unknown>
  readonly events: readonly unknown[]
}

function isLiveSession(value: unknown): value is LiveSession {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly snapshotEvents?: unknown }).snapshotEvents === 'function'
  )
}

/** Release one borrowed observation; the host pins a cold read until disposal. */
function releaseObservation(observation: SessionObservation): void {
  observation[Symbol.dispose]?.()
}

/**
 * Read one session's header and events through the host's own session reads.
 *
 * A live session is read from the session store, which is the cheapest exact
 * view and never touches persistence. A session that is not resident is read
 * through `sessionQuery.observeSession` with projections disabled: this tool
 * renders the log, not projection state, so computing it would be wasted work.
 *
 * Failures are thrown with the host's original message instead of being
 * flattened into "not found": the caller has to report what actually broke.
 */
export async function readSessionSnapshot(
  ctx: HostContext,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionSnapshot> {
  const failures: string[] = []

  try {
    const live = readServices(ctx).sessions?.get?.(sessionId)
    if (live !== undefined && live !== null) {
      if (!isLiveSession(live)) {
        throw new Error(`live session "${sessionId}" exposes no event snapshot`)
      }
      const events: unknown = live.snapshotEvents()
      return { header: live.header, events: Array.isArray(events) ? events : [] }
    }
  } catch (error) {
    failures.push(errorMessage(error))
  }

  const query = serviceOf(ctx, HostService.SessionQuery) as SessionQueryService | undefined
  if (query !== undefined && query !== null && typeof query.observeSession === 'function') {
    try {
      const observation = await query.observeSession(sessionId, {
        projectionMode: 'none',
        ...(signal === undefined ? {} : { signal }),
      })
      if (observation === undefined || observation === null || typeof observation !== 'object') {
        throw new Error(`session "${sessionId}" read returned no snapshot`)
      }
      try {
        const events: unknown = observation.events
        return { header: observation.header, events: Array.isArray(events) ? events : [] }
      } finally {
        releaseObservation(observation)
      }
    } catch (error) {
      failures.push(errorMessage(error))
    }
  }

  const lastFailure = failures[failures.length - 1]
  if (lastFailure !== undefined) throw new Error(lastFailure)
  throw new Error(
    `session "${sessionId}" cannot be read: neither the session store nor the session query service is available`,
  )
}

/** Text of a message event's content blocks. */
export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (block): block is { readonly type: 'text'; readonly text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { readonly type?: unknown }).type === 'text' &&
        typeof (block as { readonly text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
}

/**
 * Text of one conversation event.
 *
 * `user/message` carries its content directly, while `assistant/message` wraps
 * the assistant message under `message`; the log's assistant content is only
 * reachable through that wrapper. The direct form stays supported for events
 * recorded by older plugins.
 */
export function eventMessageText(event: SessionEventView): string {
  return extractMessageText(event.data?.message?.content ?? event.data?.content)
}

/** The last assistant message of a session, or `undefined` when there is none. */
export function lastAssistantEvent(events: readonly unknown[]): SessionEventView | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (
      typeof event === 'object' &&
      event !== null &&
      (event as { readonly type?: unknown }).type === SessionEventKind.AssistantMessage
    ) {
      return event as SessionEventView
    }
  }
  return undefined
}
