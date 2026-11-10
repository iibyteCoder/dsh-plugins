/**
 * Read-only tools: `session_list` and `session_get`.
 *
 * Both honour the configured read `scope` and the global allow/deny filters;
 * `session_list` additionally uses the configured `limit` and default `status`,
 * and `session_get` the configured `recent` count. A session outside the read
 * policy is reported as `SCOPE_DENIED` instead of being rendered.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { ResolvedSettings, ResolvedToolPolicy, StatusPolicy } from '../config/resolve.js'
import { renderSessionDetail, renderSessionList, renderText } from '../format/renders.js'
import { readOwnerIndex } from '../host/owner-index.js'
import {
  archivedSessionIds,
  cwdKey,
  eventMessageText,
  listSessionItems,
  loadWorkspaces,
  matchesWorkspace,
  readSessionSnapshot,
  resolveSessionStatus,
  sessionCwd,
  sessionIdOf,
  sessionModel,
  sessionStatus,
  sessionTitle,
  sessionUpdatedAt,
  workspaceForSession,
  type SessionSnapshot,
} from '../host/session-access.js'
import { readServices, requireController } from '../host/services.js'
import type { SessionSummary, WorkspaceSummary } from '../host/contracts.js'
import { asToolArgs, integerOption, nonEmptyString, stringArg, textOrDash } from '../shared/args.js'
import {
  ErrorCode,
  OwnerFilter,
  SessionEventKind,
  SessionStatus,
  StatusFilter,
  ToolName,
} from '../shared/enums.js'
import { errorMessage, sessionHubError, sessionHubText, toErrorText } from '../shared/errors.js'
import { callerCwdOf, callerIdOf } from '../shared/exec.js'
import {
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
  WorkspaceFilter,
} from '../shared/types.js'
import { isSessionVisible, type VisibilityRules } from '../domain/visibility.js'

const SESSION_LIST_DESCRIPTION = [
  'List DeepSeek Harness sessions with their workspace, cwd, status, model and owner.',
  'Use it to find a session id before calling session_get.',
].join(' ')

const SESSION_GET_DESCRIPTION = [
  'Show one DeepSeek Harness session: metadata, owner, status, and optionally the most recent user/assistant messages.',
].join(' ')

/** Build the read-only session tools bound to a host context and config. */
export function createReadTools(ctx: HostContext, settings: ResolvedSettings): ToolDefinition[] {
  return [createSessionListTool(ctx, settings), createSessionGetTool(ctx, settings)]
}

function createSessionListTool(ctx: HostContext, settings: ResolvedSettings): ToolDefinition {
  const policy = settings.tools[ToolName.SessionList]
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
          default: policy.status,
        },
        limit: {
          type: 'integer',
          description: `Maximum number of rows to return (default ${policy.limit}, max ${MAX_LIST_LIMIT}).`,
          default: policy.limit,
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
        return await executeSessionList(ctx, settings, policy, rawArgs, exec)
      } catch (error) {
        return toErrorText(error)
      }
    },
  } satisfies ToolDefinition
}

function createSessionGetTool(ctx: HostContext, settings: ResolvedSettings): ToolDefinition {
  const policy = settings.tools[ToolName.SessionGet]
  return {
    name: ToolName.SessionGet,
    description: SESSION_GET_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session id to read.',
        },
        include_recent: {
          type: 'integer',
          description: `Number of most recent user/assistant messages to include (default ${policy.recent}, max ${MAX_RECENT_MESSAGES}).`,
          default: policy.recent,
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
        return await executeSessionGet(ctx, settings, policy, rawArgs, exec)
      } catch (error) {
        return toErrorText(error)
      }
    },
  } satisfies ToolDefinition
}

async function executeSessionList(
  ctx: HostContext,
  settings: ResolvedSettings,
  policy: ResolvedToolPolicy,
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
  const statusFilter = normalizeStatusFilter(args.status, policy.status)
  const limit = integerOption(args.limit, policy.limit, MIN_LIST_LIMIT, MAX_LIST_LIMIT)

  const callerId = callerIdOf(exec)
  const rules: VisibilityRules = {
    scope: policy.scope,
    callerId,
    callerCwdKey: cwdKey(callerCwdOf(exec)),
    filters: settings.filters,
  }
  const items = await listSessionItems(controller)

  const views: SessionView[] = []
  for (const item of items) {
    const id = sessionIdOf(item)
    if (id === '') continue

    const cwd = sessionCwd(item)
    const title = sessionTitle(item)
    const status = sessionStatus(item, archived)
    const ownerId = owners[id]?.ownerSessionId
    const workspace = workspaceForSession(item, workspaces)

    if (!isSessionVisible({ sessionId: id, ownerId: ownerId ?? '', cwd, workspace }, rules)) {
      continue
    }
    if (!passesWorkspaceFilter(item, workspaceFilter, workspaces)) continue
    if (cwdFilter !== null && cwdKey(cwd) !== cwdFilter) continue
    if (titleFilter !== '' && !title.toLowerCase().includes(titleFilter)) continue
    if (!passesOwnerFilter(ownerId, ownerFilter, callerId)) continue
    const wantedStatus = statusForFilter(statusFilter)
    if (wantedStatus !== undefined && status !== wantedStatus) continue

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
  settings: ResolvedSettings,
  policy: ResolvedToolPolicy,
  rawArgs: unknown,
  exec: ToolExecContext,
): Promise<string> {
  const args = asToolArgs(rawArgs)
  const sessionId = stringArg(args, 'session_id')
  if (sessionId === '') return sessionHubText('session_id is required')

  const services = readServices(ctx)

  // Read the session before anything else: a read failure has to keep the
  // host's own message instead of being flattened into "not found".
  let snapshot: SessionSnapshot
  try {
    snapshot = await readSessionSnapshot(ctx, sessionId, exec.signal)
  } catch (error) {
    return sessionHubError(ErrorCode.GetFailed, errorMessage(error))
  }

  const header = snapshot.header
  const id = sessionIdOf(header) || sessionId
  const ownerId = (await readOwnerIndex())[id]?.ownerSessionId
  const callerId = callerIdOf(exec)
  const workspaces = await loadWorkspaces(services.workspaces)
  const workspace = workspaceForSession(
    { sessionId: id, cwd: header.cwd, workspaceId: header.workspaceId },
    workspaces,
  )
  const rules: VisibilityRules = {
    scope: policy.scope,
    callerId,
    callerCwdKey: cwdKey(callerCwdOf(exec)),
    filters: settings.filters,
  }
  const cwd = typeof header.cwd === 'string' ? header.cwd : ''

  if (!isSessionVisible({ sessionId: id, ownerId: ownerId ?? '', cwd, workspace }, rules)) {
    return sessionHubError(ErrorCode.ScopeDenied, `session "${id}" is outside the configured read scope`)
  }

  const status = await resolveSessionStatus(services, services.controller, id)

  const recentCount = integerOption(
    args.include_recent,
    policy.recent,
    MIN_RECENT_MESSAGES,
    MAX_RECENT_MESSAGES,
  )
  const recentMessages = recentMessagesOf(snapshot.events, recentCount)

  const detail: SessionDetail = {
    id,
    createdAt: header.createdAt ?? header.created_at,
    cwd: header.cwd,
    parentSession: header.parentSession ?? header.parentSessionId,
    origin: header.origin,
    agentPreset: header.agentPreset ?? header.agentPresetId,
    status,
    owner: ownerLabel(ownerId, callerId),
    recentMessages,
  }
  return renderSessionDetail(detail)
}

/** The last `count` user/assistant messages of a session, oldest first. */
function recentMessagesOf(events: readonly unknown[], count: number): SessionMessageView[] {
  if (count <= 0) return []
  const messages = events.filter(isMessageEvent).slice(-count)
  return messages.map((event) => ({
    type: event.type,
    kind: sourceKindOf(event),
    text: eventMessageText(event),
  }))
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

function normalizeStatusFilter(raw: unknown, fallback: StatusPolicy): StatusFilter {
  switch (nonEmptyString(raw)) {
    case StatusFilter.Running:
      return StatusFilter.Running
    case StatusFilter.Idle:
      return StatusFilter.Idle
    case StatusFilter.Blank:
      return StatusFilter.Blank
    case StatusFilter.Archived:
      return StatusFilter.Archived
    case StatusFilter.All:
      return StatusFilter.All
    default:
      return statusFilterOf(fallback)
  }
}

function statusFilterOf(value: StatusPolicy): StatusFilter {
  switch (value) {
    case 'running':
      return StatusFilter.Running
    case 'idle':
      return StatusFilter.Idle
    case 'blank':
      return StatusFilter.Blank
    case 'archived':
      return StatusFilter.Archived
    case 'all':
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
