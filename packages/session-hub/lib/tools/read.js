import path from 'node:path'

import { formatTable, formatTime, truncateText } from '../format.js'
import { readOwnerIndex } from '../owner-index.js'
import { readServices, requireController } from '../services.js'

const DEFAULT_LIST_LIMIT = 30
const MAX_LIST_LIMIT = 200
const MAX_RECENT_MESSAGES = 20
const MAX_RECENT_MESSAGE_CHARS = 500

const LIST_HEADER = ['ID', 'TITLE', 'WORKSPACE', 'CWD', 'STATUS', 'MODEL', 'OWNER', 'UPDATED']
const LIST_STATUSES = new Set(['running', 'idle', 'blank', 'archived', 'all'])

const RENDER_TEXT = (_args, value) => [{ type: 'text', text: String(value ?? '') }]

const SESSION_LIST_DESCRIPTION = [
  'List DeepSeek Harness sessions with their workspace, cwd, status, model and owner.',
  'Use it to find a session id before calling session_get.',
].join(' ')

const SESSION_GET_DESCRIPTION = [
  'Show one DeepSeek Harness session: metadata, owner, status, and optionally the most recent user/assistant messages.',
].join(' ')

/**
 * Build the read-only session tools bound to a host context.
 *
 * Read tools are allowed on every session in both permission modes, so the
 * mode is accepted for a uniform factory signature but does not change them.
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @param {{permissionMode?: 'permissive' | 'owned'}} [options]
 * @returns {object[]} Tool definitions ready for `ctx.tools.register`.
 */
export function createReadTools(ctx, { permissionMode } = {}) {
  return [createSessionListTool(ctx), createSessionGetTool(ctx)]
}

function createSessionListTool(ctx) {
  return {
    name: 'session_list',
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
          default: 'any',
        },
        status: {
          type: 'string',
          description: 'Status filter. "all" disables status filtering.',
          enum: ['running', 'idle', 'blank', 'archived', 'all'],
          default: 'all',
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
      render: RENDER_TEXT,
    },
    async execute(args, exec) {
      try {
        return await executeSessionList(ctx, args, exec)
      } catch (error) {
        return toErrorText(error)
      }
    },
  }
}

function createSessionGetTool(ctx) {
  return {
    name: 'session_get',
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
          default: 0,
        },
      },
      required: ['session_id'],
    },
    output: {
      schema: { type: 'string' },
      render: RENDER_TEXT,
    },
    async execute(args, exec) {
      try {
        return await executeSessionGet(ctx, args, exec)
      } catch (error) {
        return toErrorText(error)
      }
    },
  }
}

async function executeSessionList(ctx, rawArgs, exec) {
  const args = rawArgs ?? {}
  const services = readServices(ctx)
  const controller = requireController(ctx)

  const workspaces = await loadWorkspaces(services.workspaces)
  const archived = archivedSessionIds(services.workspaces)
  const owners = await readOwnerIndex()

  const workspaceFilter = buildWorkspaceFilter(args.workspace, workspaces)
  const cwdFilter = nonEmptyString(args.cwd) === '' ? null : normalizePath(args.cwd)
  const titleFilter = nonEmptyString(args.title_contains).toLowerCase()
  const ownerFilter = buildOwnerFilter(args.owner)
  const statusFilter = normalizeStatusFilter(args.status)
  const limit = integerOption(args.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT)

  const callerId = exec?.agent?.id
  const listing = await controller.list({})
  const items = Array.isArray(listing?.items) ? listing.items : []

  const rows = []
  for (const item of items) {
    const id = sessionIdOf(item)
    if (id === '') continue

    const cwd = sessionCwd(item)
    const title = sessionTitle(item)
    const status = sessionStatus(item, archived)
    const ownerId = owners[id]?.ownerSessionId

    if (!passesWorkspaceFilter(item, workspaceFilter, workspaces)) continue
    if (cwdFilter !== null && normalizePath(cwd) !== cwdFilter) continue
    if (titleFilter !== '' && !title.toLowerCase().includes(titleFilter)) continue
    if (!passesOwnerFilter(ownerId, ownerFilter, callerId)) continue
    if (statusFilter !== 'all' && status !== statusFilter) continue

    const workspace = workspaceForSession(item, workspaces)
    rows.push([
      id,
      title === '' ? '-' : title,
      workspace?.title ?? '-',
      cwd === '' ? '-' : cwd,
      status,
      sessionModel(item) || '-',
      ownerLabel(ownerId, callerId),
      formatTime(sessionUpdatedAt(item)),
    ])
  }

  if (rows.length === 0) return '未找到匹配的会话。'

  const shown = rows.slice(0, limit)
  const table = formatTable([LIST_HEADER, ...shown])
  return `${table}\n\n共 ${rows.length} 个会话（显示 ${shown.length} 个）`
}

async function executeSessionGet(ctx, rawArgs, exec) {
  const args = rawArgs ?? {}
  const sessionId = nonEmptyString(args.session_id)
  if (sessionId === '') return 'session-hub: session_id is required'

  const services = readServices(ctx)
  const controller = requireController(ctx)

  let inspection
  try {
    inspection = await controller.inspect(sessionId, exec?.signal)
  } catch {
    return `session-hub: session "${sessionId}" not found`
  }
  if (inspection === null || typeof inspection !== 'object') {
    return `session-hub: session "${sessionId}" not found`
  }

  const meta = inspection.meta ?? {}
  const id = sessionIdOf(meta) || sessionId
  const ownerId = (await readOwnerIndex())[id]?.ownerSessionId
  const status = await resolveSessionStatus(services, controller, id)
  const callerId = exec?.agent?.id

  const fields = [
    ['id', id],
    ['createdAt', formatTime(meta.createdAt ?? meta.created_at ?? inspection.createdAt)],
    ['cwd', displayValue(meta.cwd ?? inspection.cwd)],
    ['parentSession', displayValue(meta.parentSession ?? meta.parentSessionId ?? inspection.parentSession)],
    ['origin', displayValue(meta.origin ?? inspection.origin)],
    ['agentPreset', displayValue(meta.agentPreset ?? meta.agentPresetId ?? inspection.agentPreset)],
    ['status', status],
    ['owner', ownerLabel(ownerId, callerId)],
  ]

  const lines = [`会话 ${id}`, ...fields.map(([key, value]) => `- ${key}: ${value}`)]

  const recentCount = integerOption(args.include_recent, 0, 0, MAX_RECENT_MESSAGES)
  if (recentCount > 0) {
    const events = Array.isArray(inspection.events) ? inspection.events : []
    const messages = events.filter(
      (event) => event?.type === 'user/message' || event?.type === 'assistant/message',
    )
    if (messages.length > 0) {
      const recent = messages.slice(-recentCount)
      lines.push('', '最近消息：')
      recent.forEach((event, index) => {
        lines.push(`${index + 1}. ${formatMessage(event)}`)
      })
    }
  }

  return lines.join('\n')
}

async function resolveSessionStatus(services, controller, id) {
  if (isArchived(services.workspaces, id)) return 'archived'

  let agentStatus
  try {
    agentStatus = services.agents?.get?.(id)?.status
  } catch {
    agentStatus = undefined
  }
  if (typeof agentStatus === 'string' && agentStatus !== '') return agentStatus

  const item = await findListItem(controller, id)
  if (item !== undefined) return baseSessionStatus(item)
  return 'unknown'
}

async function findListItem(controller, id) {
  if (typeof controller.list !== 'function') return undefined
  try {
    const listing = await controller.list({})
    const items = Array.isArray(listing?.items) ? listing.items : []
    return items.find((item) => sessionIdOf(item) === id)
  } catch {
    return undefined
  }
}

async function loadWorkspaces(registry) {
  if (registry === undefined || registry === null || typeof registry.list !== 'function') return []
  try {
    const listed = await registry.list()
    return Array.isArray(listed) ? listed : []
  } catch {
    return []
  }
}

function archivedSessionIds(registry) {
  const ids = registry?.archivedSessionIds
  return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [])
}

function isArchived(registry, id) {
  const ids = registry?.archivedSessionIds
  return Array.isArray(ids) && ids.includes(id)
}

function workspaceForSession(item, workspaces) {
  const id = sessionIdOf(item)
  const cwd = normalizePath(sessionCwd(item))
  const workspaceId = item?.workspaceId

  return workspaces.find((workspace) => {
    if (workspaceId !== undefined && workspace?.id === workspaceId) return true
    if (Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(id)) return true
    const root = normalizePath(workspace?.path)
    return cwd !== '' && root !== '' && isWithinPath(cwd, root)
  })
}

function buildWorkspaceFilter(raw, workspaces) {
  const needle = nonEmptyString(raw)
  if (needle === '') return null
  return {
    needle,
    matched: workspaces.filter((workspace) => matchesWorkspaceArgument(workspace, needle)),
  }
}

function matchesWorkspaceArgument(workspace, needle) {
  if (typeof workspace?.id === 'string' && workspace.id === needle) return true
  if (typeof workspace?.title === 'string' && workspace.title.toLowerCase() === needle.toLowerCase()) {
    return true
  }
  const root = normalizePath(workspace?.path)
  return root !== '' && root === normalizePath(needle)
}

function passesWorkspaceFilter(item, filter, workspaces) {
  if (filter === null) return true
  if (filter.matched.length > 0) {
    const workspace = workspaceForSession(item, workspaces)
    return workspace !== undefined && filter.matched.includes(workspace)
  }
  return String(item?.workspaceId ?? '').toLowerCase() === filter.needle.toLowerCase()
}

function buildOwnerFilter(raw) {
  const value = nonEmptyString(raw)
  if (value === '' || value === 'any') return 'any'
  return value
}

function passesOwnerFilter(ownerId, filter, callerId) {
  if (filter === 'any') return true
  if (filter === 'self') return typeof callerId === 'string' && ownerId === callerId
  return ownerId === filter
}

function normalizeStatusFilter(raw) {
  const value = nonEmptyString(raw)
  return LIST_STATUSES.has(value) ? value : 'all'
}

function ownerLabel(ownerId, callerId) {
  if (typeof ownerId !== 'string' || ownerId === '') return '-'
  return ownerId === callerId ? 'self' : ownerId
}

function baseSessionStatus(item) {
  if (item?.running === true || item?.status === 'running') return 'running'
  if (item?.blank === true || item?.status === 'blank') return 'blank'
  return 'idle'
}

function sessionStatus(item, archived) {
  return archived.has(sessionIdOf(item)) ? 'archived' : baseSessionStatus(item)
}

function sessionIdOf(item) {
  const id = item?.sessionId ?? item?.id
  return typeof id === 'string' ? id : ''
}

function sessionCwd(item) {
  const cwd = item?.cwd ?? item?.meta?.cwd
  return typeof cwd === 'string' ? cwd : ''
}

function sessionTitle(item) {
  const title = item?.projections?.values?.title ?? item?.title
  return typeof title === 'string' ? title : ''
}

function sessionModel(item) {
  const model = item?.projections?.values?.modelSelection?.model
  return typeof model === 'string' ? model : ''
}

function sessionUpdatedAt(item) {
  return item?.updatedAt ?? item?.projections?.values?.updatedAt ?? item?.createdAt
}

function normalizePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  const resolved = path.resolve(value.trim())
  const withoutTrailingSeparator = resolved.length > 1 ? resolved.replace(/[\\/]+$/, '') : resolved
  return withoutTrailingSeparator.toLowerCase()
}

function isWithinPath(candidate, root) {
  if (candidate === root) return true
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  return candidate.startsWith(prefix)
}

function nonEmptyString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function integerOption(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'number' && !Number.isFinite(value)) return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function displayValue(value) {
  if (value === undefined || value === null || value === '') return '-'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (typeof value === 'object') {
    if (typeof value.id === 'string') return value.id
    if (typeof value.kind === 'string') return value.kind
    return '-'
  }
  return '-'
}

function formatMessage(event) {
  const role = event.type === 'user/message' ? 'user' : 'assistant'
  const kind = event?.data?.source?.kind
  const label = role === 'user' && typeof kind === 'string' && kind !== '' ? `${role}:${kind}` : role
  const text = truncateText(extractText(event?.data?.content), MAX_RECENT_MESSAGE_CHARS)
  return `[${label}] ${text === '' ? '(无文本内容)' : text}`
}

function extractText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function toErrorText(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.startsWith('session-hub: ') ? message : `session-hub: ${message}`
}
