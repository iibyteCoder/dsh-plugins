/**
 * Read-only tools: `session_list` and `session_get`.
 *
 * Read tools are allowed on every session in both permission modes, so the
 * mode is accepted for a uniform factory signature but does not change them.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { renderSessionDetail, renderSessionList, renderText } from '../format/renders.js'
import { readOwnerIndex } from '../host/owner-index.js'
import {
  archivedSessionIds,
  cwdKey,
  extractMessageText,
  listSessionItems,
  loadWorkspaces,
  matchesWorkspace,
  resolveSessionStatus,
  sessionCwd,
  sessionIdOf,
  sessionModel,
  sessionStatus,
  sessionTitle,
  sessionUpdatedAt,
  workspaceForSession,
} from '../host/session-access.js'
import { readServices, requireController } from '../host/services.js'
import type { SessionInspection, SessionSummary, WorkspaceSummary } from '../host/contracts.js'
import { asToolArgs, integerOption, nonEmptyString, stringArg, textOrDash } from '../shared/args.js'
import { OwnerFilter, SessionEventKind, SessionStatus, StatusFilter, ToolName } from '../shared/enums.js'
import { sessionHubText, toErrorText } from '../shared/errors.js'
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  MAX_RECENT_MESSAGES,
  MIN_LIST_LIMIT,
  MIN_RECENT_MESSAGES,
} from '../shared/limits.js'
import type {
  HostContext,
  SessionDetail,
  SessionEventView,
  SessionMessageView,
  SessionView,
  ToolExecContext,
  ToolOptions,
  WorkspaceFilter,
} from '../shared/types.js'

const SESSION_LIST_DESCRIPTION = [
  'List DeepSeek Harness sessions with their workspace, cwd, status, model and owner.',
  'Use it to find a session id before calling session_get.',
].join(' ')

const SESSION_GET_DESCRIPTION = [
  'Show one DeepSeek Harness session: metadata, owner, status, and optionally the most recent user/assistant messages.',
].join(' ')

/** Build the read-only session tools bound to a host context. */
export function createReadTools(ctx: HostContext, _options?: ToolOptions): ToolDefinition[] {
  return [createSessionListTool(ctx), createSessionGetTool(ctx)]
}

function createSessionListTool(ctx: HostContext): ToolDefinition {
  return {
    name: ToolName.SessionList,
    description: SESSION_LIST_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: 'Workspace id, title, or path. Paths are resolved and compared case-insensitively.',
        },
        cwd: {
          type: 'string',
          description: 'Exact session cwd (resolved before comparison).',
        },
        title_contains: {
          type: 'string',
          description: 'Case-insensitive substring of the session title.',
        },
        owner: {
          type: 'string',
          description: 'Owner filter: "self", "any" (default), or another session id.',
          default: OwnerFilter.Any,
        },
        status: {
          type: 'string',
          description: 'Status filter. "all" disables status filtering.',
          enum: [
            SessionStatus.Running,
            SessionStatus.Idle,
            SessionStatus.Blank,
            SessionStatus.Archived,
            StatusFilter.All,
          ],
          default: StatusFilter.All,
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of rows to return (default 30, max 200).',
          default: DEFAULT_LIST_LIMIT,
        },
      },
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render: renderText,
    },
    async execute(rawArgs, exec) {
      try {
        return await executeSessionList(ctx, rawArgs, exec)
      } catch (error) {
        return toErrorText(error)
      }
    },
  } satisfies ToolDefinition
}

function createSessionGetTool(ctx: HostContext): ToolDefinition {
  return {
    name: ToolName.SessionGet,
    description: SESSION_GET_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session id to inspect.',
        },
        include_recent: {
          type: 'integer',
          description: 'Number of most recent user/assistant messages to include (default 0, max 20).',
          default: MIN_RECENT_MESSAGES,
        },
      },
      required: ['session_id'],
    },
    output: {
      schema: { type: 'string' },
      render: renderText,
    },
    async execute(rawArgs, exec) {
      try {
        return await executeSessionGet(ctx, rawArgs, exec)
      } catch (error) {
        return toErrorText(error)
      }
    },
  } satisfies ToolDefinition
}

async function executeSessionList(
  ctx: HostContext,
  rawArgs: unknown,
  exec: ToolExecContext,
): Promise<string> {
  const args = asToolArgs(rawArgs)
  const services = readServices(ctx)
  const controller = requireController(ctx)

  const workspaces = await loadWorkspaces(services.workspaces)
  const archived = new Set(archivedSessionIds(services.workspaces))
  const owners = await readOwnerIndex()

  const workspaceFilter = buildWorkspaceFilter(stringArg(args, 'workspace'), workspaces)
  const cwdFilter = stringArg(args, 'cwd') === '' ? null : cwdKey(args.cwd)
  const titleFilter = stringArg(args, 'title_contains').toLowerCase()
  const ownerFilter = buildOwnerFilter(args.owner)
  const statusFilter = normalizeStatusFilter(args.status)
  const limit = integerOption(args.limit, DEFAULT_LIST_LIMIT, MIN_LIST_LIMIT, MAX_LIST_LIMIT)

  const callerId = callerViewerId(exec)
  const items = await listSessionItems(controller)

  const views: SessionView[] = []
  for (const item of items) {
    const id = sessionIdOf(item)
    if (id === '') continue

    const cwd = sessionCwd(item)
    const title = sessionTitle(item)
    const status = sessionStatus(item, archived)
    const ownerId = owners[id]?.ownerSessionId

    if (!passesWorkspaceFilter(item, workspaceFilter, workspaces)) continue
    if (cwdFilter !== null && cwdKey(cwd) !== cwdFilter) continue
    if (titleFilter !== '' && !title.toLowerCase().includes(titleFilter)) continue
    if (!passesOwnerFilter(ownerId, ownerFilter, callerId)) continue
    const wantedStatus = statusForFilter(statusFilter)
    if (wantedStatus !== undefined && status !== wantedStatus) continue

    const workspace = workspaceForSession(item, workspaces)
    views.push({
      id,
      title,
      workspace: textOrDash(workspace?.title),
      cwd,
      status,
      model: sessionModel(item),
      owner: ownerLabel(ownerId, callerId),
      updatedAt: sessionUpdatedAt(item),
    })
  }

  return renderSessionList({ rows: views.slice(0, limit), total: views.length })
}

async function executeSessionGet(
  ctx: HostContext,
  rawArgs: unknown,
  exec: ToolExecContext,
): Promise<string> {
  const args = asToolArgs(rawArgs)
  const sessionId = stringArg(args, 'session_id')
  if (sessionId === '') return sessionHubText('session_id is required')

  const services = readServices(ctx)
  const controller = requireController(ctx)

  let inspection: SessionInspection | null | undefined
  try {
    inspection = await controller.inspect(sessionId, exec.signal)
  } catch {
    return sessionHubText(`session "${sessionId}" not found`)
  }
  if (inspection === null || inspection === undefined || typeof inspection !== 'object') {
    return sessionHubText(`session "${sessionId}" not found`)
  }

  const meta = inspection.meta ?? {}
  const id = sessionIdOf(meta) || sessionId
  const ownerId = (await readOwnerIndex())[id]?.ownerSessionId
  const status = await resolveSessionStatus(services, controller, id)
  const callerId = callerViewerId(exec)

  const recentCount = integerOption(
    args.include_recent,
    MIN_RECENT_MESSAGES,
    MIN_RECENT_MESSAGES,
    MAX_RECENT_MESSAGES,
  )
  const recentMessages: SessionMessageView[] = []
  if (recentCount > 0) {
    const events: readonly unknown[] = Array.isArray(inspection.events) ? inspection.events : []
    const messages = events.filter(isMessageEvent)
    const recent = messages.slice(-recentCount)
    for (const event of recent) {
      recentMessages.push({
        type: event.type,
        kind: sourceKindOf(event),
        text: extractMessageText(event.data?.content),
      })
    }
  }

  const detail: SessionDetail = {
    id,
    createdAt: meta.createdAt ?? meta.created_at ?? inspection.createdAt,
    cwd: meta.cwd ?? inspection.cwd,
    parentSession: meta.parentSession ?? meta.parentSessionId ?? inspection.parentSession,
    origin: meta.origin ?? inspection.origin,
    agentPreset: meta.agentPreset ?? meta.agentPresetId ?? inspection.agentPreset,
    status,
    owner: ownerLabel(ownerId, callerId),
    recentMessages,
  }
  return renderSessionDetail(detail)
}

function isMessageEvent(event: unknown): event is SessionEventView & { type: SessionEventKind } {
  if (typeof event !== 'object' || event === null) return false
  const type = (event as { readonly type?: unknown }).type
  return type === SessionEventKind.UserMessage || type === SessionEventKind.AssistantMessage
}

function sourceKindOf(event: SessionEventView): string {
  const kind = event.data?.source?.kind
  return typeof kind === 'string' ? kind : ''
}

function buildWorkspaceFilter(
  raw: unknown,
  workspaces: readonly WorkspaceSummary[],
): WorkspaceFilter | null {
  const needle = nonEmptyString(raw)
  if (needle === '') return null
  return {
    needle,
    matched: workspaces.filter((workspace) => matchesWorkspace(workspace, needle)),
  }
}

function passesWorkspaceFilter(
  item: SessionSummary,
  filter: WorkspaceFilter | null,
  workspaces: readonly WorkspaceSummary[],
): boolean {
  if (filter === null) return true
  if (filter.matched.length > 0) {
    const workspace = workspaceForSession(item, workspaces)
    return workspace !== undefined && filter.matched.includes(workspace)
  }
  return String(item.workspaceId ?? '').toLowerCase() === filter.needle.toLowerCase()
}

function buildOwnerFilter(raw: unknown): string {
  const value = nonEmptyString(raw)
  if (value === '' || value === OwnerFilter.Any) return OwnerFilter.Any
  return value
}

function passesOwnerFilter(ownerId: unknown, filter: string, callerId: string | undefined): boolean {
  if (filter === OwnerFilter.Any) return true
  if (filter === OwnerFilter.Self) return typeof callerId === 'string' && ownerId === callerId
  return ownerId === filter
}

function normalizeStatusFilter(raw: unknown): StatusFilter {
  const value = nonEmptyString(raw)
  switch (value) {
    case StatusFilter.Running:
      return StatusFilter.Running
    case StatusFilter.Idle:
      return StatusFilter.Idle
    case StatusFilter.Blank:
      return StatusFilter.Blank
    case StatusFilter.Archived:
      return StatusFilter.Archived
    default:
      return StatusFilter.All
  }
}

function statusForFilter(filter: StatusFilter): SessionStatus | undefined {
  switch (filter) {
    case StatusFilter.Running:
      return SessionStatus.Running
    case StatusFilter.Idle:
      return SessionStatus.Idle
    case StatusFilter.Blank:
      return SessionStatus.Blank
    case StatusFilter.Archived:
      return SessionStatus.Archived
    case StatusFilter.All:
      return undefined
  }
}

function ownerLabel(ownerId: unknown, callerId: string | undefined): string {
  if (typeof ownerId !== 'string' || ownerId === '') return '-'
  return ownerId === callerId ? 'self' : ownerId
}

function callerViewerId(exec: ToolExecContext): string | undefined {
  return typeof exec.agent?.id === 'string' ? exec.agent.id : undefined
}
