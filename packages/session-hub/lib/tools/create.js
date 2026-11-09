import path from 'node:path'

import { resolveModelSelection } from '../control.js'
import { wake } from '../messaging.js'
import { recordOwner } from '../owner-index.js'
import { requireController, serviceOf } from '../services.js'

const RENDER_TEXT = (_args, value) => [{ type: 'text', text: String(value ?? '') }]

const SESSION_CREATE_DESCRIPTION = [
  'Create a new DeepSeek Harness session, optionally inside a workspace or at a specific cwd, and record the calling session as its owner.',
  'The required message is delivered to the new session as its initial task, which starts it immediately.',
  'Returns the new session id.',
].join(' ')

/**
 * Build the `session_create` tool bound to a host context.
 *
 * The permission mode is accepted for a uniform factory signature;
 * `session_create` behaves the same in every mode.
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @param {{permissionMode?: 'permissive' | 'owned'}} [options]
 * @returns {object} Tool definition ready for `ctx.tools.register`.
 */
export function createSessionCreateTool(ctx, { permissionMode } = {}) {
  return {
    name: 'session_create',
    description: SESSION_CREATE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: 'Workspace id, title, or path. Mutually exclusive with cwd.',
        },
        cwd: {
          type: 'string',
          description: 'Directory for the new session. Mutually exclusive with workspace.',
        },
        title: {
          type: 'string',
          description: 'Title to apply right after the session is created.',
        },
        agent_preset: {
          type: 'string',
          description: 'Agent preset passed to the host create request.',
        },
        model: {
          type: 'string',
          description: 'Model id to select after creation. Resolved against the model catalog when provider is omitted.',
        },
        provider: {
          type: 'string',
          description: 'Provider id for model. Requires model.',
        },
        reasoning_effort: {
          type: 'string',
          description: 'Reasoning effort for the selected model. Requires model.',
        },
        message: {
          type: 'string',
          description: 'Initial task delivered to the new session; it starts the session immediately.',
        },
      },
      required: ['message'],
    },
    output: {
      schema: { type: 'string' },
      render: RENDER_TEXT,
    },
    async execute(args, exec) {
      try {
        return await executeSessionCreate(ctx, args, exec)
      } catch (error) {
        return toErrorText(error)
      }
    },
  }
}

async function executeSessionCreate(ctx, rawArgs, exec) {
  const args = rawArgs ?? {}
  const controller = requireController(ctx)

  const message = nonEmptyString(args.message)
  if (message === '') return 'session-hub: message is required'

  const workspaceArg = nonEmptyString(args.workspace)
  const cwdArg = nonEmptyString(args.cwd)
  if (workspaceArg !== '' && cwdArg !== '') {
    return 'session-hub: workspace and cwd are mutually exclusive'
  }

  // Build the create request. `workspaceId` and `cwd` are mutually exclusive at
  // the host boundary too, so only one of them can ever be set here.
  const request = {}
  let workspace = null
  if (workspaceArg !== '') {
    workspace = await findWorkspace(ctx, workspaceArg)
    if (workspace === null) return `session-hub: workspace "${workspaceArg}" not found`
    request.workspaceId = workspace.id
  } else if (cwdArg !== '') {
    request.cwd = normalizePath(cwdArg)
  } else {
    const callerCwd = normalizePath(exec?.agent?.session?.header?.cwd)
    if (callerCwd !== '') request.cwd = callerCwd
  }

  const title = nonEmptyString(args.title)
  const agentPreset = nonEmptyString(args.agent_preset)
  if (agentPreset !== '') request.agentPreset = agentPreset

  let created
  try {
    created = await controller.create(request)
  } catch (error) {
    return `session-hub: create failed: ${errorMessage(error)}`
  }

  const sessionId = nonEmptyString(created?.sessionId)
  if (sessionId === '') return 'session-hub: create failed: host returned no session id'

  const callerId = typeof exec?.agent?.id === 'string' ? exec.agent.id.trim() : ''
  const ownerLabel = await recordOwnership(sessionId, callerId)

  const lines = [
    `已创建会话 ${sessionId}`,
    `- workspace: ${workspace?.title ?? '-'}`,
    `- cwd: ${request.cwd ?? '-'}`,
    `- agentPreset: ${presetLabel(created, agentPreset)}`,
    `- owner: ${ownerLabel}`,
  ]

  if (title !== '') {
    try {
      await controller.rename({ sessionId, title })
    } catch (error) {
      // The session exists either way; report the rename problem without
      // turning a successful create into a failure.
      lines.push(`- title: 设置失败（${errorMessage(error)}）`)
    }
  }

  // The session is already created at this point: a model problem must be
  // reported, never turn the create result into a failure.
  if (hasModelRequest(args)) {
    const resolution = await resolveModelSelection(controller, args)
    if (resolution?.error !== undefined) {
      lines.push(`- model: 失败（${resolution.error}）`)
    } else if (resolution !== null) {
      const selection = resolution.selection
      try {
        await controller.selectModel({ sessionId, ...selection })
        lines.push(`- model: ${selection.provider}/${selection.model}`)
      } catch (error) {
        lines.push(`- model: 失败（${errorMessage(error)}）`)
      }
    }
  }

  // The initial task is delivered after rename/model selection so the first
  // turn already sees the intended title and model. Like the model step, a
  // delivery problem is reported on its own line and never turns create into a
  // failure.
  const delivery = await deliverInitialTask(ctx, sessionId, message, callerId)
  lines.push(`- started: ${delivery}`)

  return lines.join('\n')
}

/**
 * Deliver the initial task to the freshly created session.
 *
 * Wake semantics are used (`followup` on the idle new session) so the session
 * starts working immediately instead of waiting for a later turn.
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @param {string} sessionId - Newly created session.
 * @param {string} message - Initial task text.
 * @param {string} callerId - Session that created the new one (may be empty).
 * @returns {Promise<string>} Label for the `started` line.
 */
async function deliverInitialTask(ctx, sessionId, message, callerId) {
  let result
  try {
    result = await wake(ctx, { sessionId, text: message, senderId: callerId })
  } catch (error) {
    result = { ok: false, text: `session-hub: send failed: ${errorMessage(error)}` }
  }
  return result.ok ? '已投递初始任务' : `失败（${result.text}）`
}

/**
 * Persist the caller → new session relationship.
 *
 * A missing caller id is not an error: the session was still created, so the
 * result only says ownership is unknown.
 *
 * @param {string} sessionId
 * @param {string} callerId
 * @returns {Promise<string>} Label for the `owner` line.
 */
async function recordOwnership(sessionId, callerId) {
  if (callerId === '') return '未知（调用方会话 id 不可用）'
  try {
    await recordOwner(sessionId, callerId)
    return 'self'
  } catch (error) {
    return `记录失败（${errorMessage(error)}）`
  }
}

/**
 * Find a workspace by exact id, case-insensitive title, or normalized path.
 *
 * @param {object} ctx
 * @param {string} needle
 * @returns {Promise<object|null>}
 */
async function findWorkspace(ctx, needle) {
  const registry = serviceOf(ctx, 'workspaceRegistry')
  if (registry === undefined || registry === null || typeof registry.list !== 'function') return null

  let listed
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

/**
 * @param {object} workspace
 * @param {string} needle
 * @returns {boolean}
 */
function matchesWorkspace(workspace, needle) {
  if (typeof workspace?.id === 'string' && workspace.id === needle) return true
  if (typeof workspace?.title === 'string' && workspace.title.toLowerCase() === needle.toLowerCase()) {
    return true
  }
  const key = pathKey(needle)
  return key !== '' && pathKey(workspace?.path) === key
}

/**
 * Normalize a path for comparison or for passing to the host.
 *
 * Absolute, without trailing separators; case is preserved for display, while
 * callers that compare paths use `pathKey`.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  const resolved = path.resolve(value.trim())
  return stripTrailingSeparators(resolved)
}

/**
 * @param {string} resolved
 * @returns {string}
 */
function stripTrailingSeparators(resolved) {
  const root = path.parse(resolved).root
  let value = resolved
  while (value.length > root.length && /[\\/]$/.test(value)) value = value.slice(0, -1)
  return value
}

/**
 * Case-insensitive comparison key for a path.
 *
 * @param {unknown} value
 * @returns {string}
 */
function pathKey(value) {
  return normalizePath(value).toLowerCase()
}

/**
 * @param {unknown} created
 * @param {string} requested
 * @returns {string}
 */
function presetLabel(created, requested) {
  const resolved = created?.agentPreset
  if (typeof resolved === 'string' && resolved !== '') return resolved
  return requested === '' ? '-' : requested
}

/**
 * True when any model-selection argument carries a value.
 *
 * @param {object} args
 * @returns {boolean}
 */
function hasModelRequest(args) {
  return (
    nonEmptyString(args.model) !== '' ||
    nonEmptyString(args.provider) !== '' ||
    nonEmptyString(args.reasoning_effort) !== ''
  )
}

function nonEmptyString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function toErrorText(error) {
  const message = errorMessage(error)
  return message.startsWith('session-hub: ') ? message : `session-hub: ${message}`
}
