/**
 * One read model of session state, shared by `session_list`, `session_get`
 * and `session_wait`.
 *
 * The host exposes several overlapping projections (listing rows, inspection
 * metadata, live agents, archived ids). Keeping the precedence rules here
 * means the three tools cannot disagree about whether a session is running,
 * archived or unknown.
 */
import path from 'node:path'

import { HostService, SessionEventKind, SessionStatus } from '../shared/enums.js'
import type { HostContext, SessionEventView } from '../shared/types.js'
import type {
  SessionController,
  SessionIdentity,
  SessionInspection,
  SessionListValue,
  SessionSnapshot,
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

/** Session id of a listing row or inspection metadata. */
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

/** Find one row in the host listing; inspection failures yield `undefined`. */
export async function findSessionItem(
  controller: SessionController,
  id: string,
): Promise<SessionSummary | undefined> {
  if (typeof controller.list !== 'function') return undefined
  try {
    const items = await listSessionItems(controller)
    return items.find((item) => sessionIdOf(item) === id)
  } catch {
    return undefined
  }
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
  controller: SessionController,
  id: string,
): Promise<SessionStatus> {
  if (isArchived(services.workspaces, id)) return SessionStatus.Archived

  const agentStatus = readAgentStatus(services, id)
  if (agentStatus !== '') return toSessionStatus(agentStatus)

  const item = await findSessionItem(controller, id)
  if (item !== undefined) return baseSessionStatus(item)
  return SessionStatus.Unknown
}

/** Snapshot events of a live session, or `[]` when it is not resident. */
function readSnapshotEvents(ctx: HostContext, sessionId: string): readonly SessionEventView[] {
  try {
    const session = readServices(ctx).sessions?.get?.(sessionId) as SessionSnapshot | undefined
    if (session === undefined || session === null || typeof session.snapshotEvents !== 'function') {
      return []
    }
    const events: readonly unknown[] = session.snapshotEvents()
    return Array.isArray(events) ? (events as readonly SessionEventView[]) : []
  } catch {
    return []
  }
}

async function inspectEvents(
  controller: SessionController,
  sessionId: string,
): Promise<readonly SessionEventView[]> {
  if (typeof controller.inspect !== 'function') return []
  try {
    const inspection: SessionInspection | null | undefined = await controller.inspect(sessionId)
    const events = inspection?.events
    return Array.isArray(events) ? (events as readonly SessionEventView[]) : []
  } catch {
    return []
  }
}

/**
 * Read the conversation events of a session, preferring the live snapshot and
 * falling back to a log inspection for a session that is not resident.
 */
export async function readSessionEvents(
  ctx: HostContext,
  sessionId: string,
): Promise<readonly SessionEventView[]> {
  const events = [...readSnapshotEvents(ctx, sessionId)]
  if (events.length === 0) {
    const controller = serviceOf(ctx, HostService.SessionController) as
      | SessionController
      | null
      | undefined
    if (controller !== undefined && controller !== null) {
      events.push(...(await inspectEvents(controller, sessionId)))
    }
  }
  return events
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

/** The last assistant message of a session, or `''` when there is none. */
export function lastAssistantEvent(
  events: readonly SessionEventView[],
): SessionEventView | undefined {
  return [...events]
    .reverse()
    .find((event) => event.type === SessionEventKind.AssistantMessage)
}
