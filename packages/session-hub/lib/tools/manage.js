/**
 * Mutating session tools: `session_update`, `session_close`, `session_open`.
 *
 * Authorization is enforced here against the plugin's owner index, before any
 * host change is attempted. The tools never throw: every failure is rendered
 * as `session-hub: ...` text so a misbehaving call cannot take down the agent.
 */
import {
  confirmError,
  confirmRequired,
  ownerOf,
  resolveModelSelection,
} from '../control.js'
import { requireController, requireWorkspaceController } from '../services.js'

const RENDER_TEXT = (_args, value) => [{ type: 'text', text: String(value ?? '') }]

const SELF_CLOSE_ERROR = 'session-hub: SELF_CLOSE_FORBIDDEN: a session cannot close itself'

const SESSION_UPDATE_DESCRIPTION =
  'Update an existing DeepSeek Harness session: rename it and/or select its model.'

const SESSION_UPDATE_DESCRIPTION_OWNED = [
  SESSION_UPDATE_DESCRIPTION,
  'Updating a session the caller did not create requires confirm: true.',
].join(' ')

const SESSION_CLOSE_DESCRIPTION = [
  'Close a DeepSeek Harness session by archiving it and stopping its activity.',
  'Restore it later with session_open. The calling session cannot close itself.',
].join(' ')

const SESSION_CLOSE_DESCRIPTION_OWNED = [
  'Close a DeepSeek Harness session by archiving it and stopping its activity.',
  'Restore it later with session_open. Closing the calling session or a session the caller did not create requires confirm: true.',
].join(' ')

const SESSION_OPEN_DESCRIPTION = [
  'Restore a previously closed (archived) DeepSeek Harness session. It is idempotent and needs no confirmation.',
].join(' ')

/**
 * Build the mutating session tools bound to a host context.
 *
 * The permission mode is normalized by `lib/config.js` when the plugin is
 * applied. Any value other than `'owned'` (including the default) registers
 * the permissive surface: no `confirm` parameter and no ownership checks.
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @param {{permissionMode?: 'permissive' | 'owned'}} [options]
 * @returns {object[]} Tool definitions ready for `ctx.tools.register`.
 */
export function createManageTools(ctx, { permissionMode = 'permissive' } = {}) {
  return [
    createSessionUpdateTool(ctx, permissionMode),
    createSessionCloseTool(ctx, permissionMode),
    createSessionOpenTool(ctx),
  ]
}

function createSessionUpdateTool(ctx, permissionMode) {
  const owned = permissionMode === 'owned'
  const properties = {
    session_id: {
      type: 'string',
      description: 'Session id to update.',
    },
    title: {
      type: 'string',
      description: 'New session title.',
    },
    model: {
      type: 'string',
      description: 'Model id to select. Resolved against the model catalog when provider is omitted.',
    },
    provider: {
      type: 'string',
      description: 'Provider id for model. Requires model.',
    },
    reasoning_effort: {
      type: 'string',
      description: 'Reasoning effort for the selected model. Requires model.',
    },
  }
  if (owned) {
    properties.confirm = {
      type: 'boolean',
      description: 'Must be true to update a session the caller did not create.',
    }
  }

  return {
    name: 'session_update',
    description: owned ? SESSION_UPDATE_DESCRIPTION_OWNED : SESSION_UPDATE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties,
      required: ['session_id'],
    },
    output: {
      schema: { type: 'string' },
      render: RENDER_TEXT,
    },
    async execute(args, exec) {
      try {
        return await executeSessionUpdate(ctx, args, exec, permissionMode)
      } catch (error) {
        return toErrorText(error)
      }
    },
  }
}

function createSessionCloseTool(ctx, permissionMode) {
  const owned = permissionMode === 'owned'
  const properties = {
    session_id: {
      type: 'string',
      description: 'Session id to close.',
    },
  }
  if (owned) {
    properties.confirm = {
      type: 'boolean',
      description: 'Must be true to close the calling session or a session the caller did not create.',
    }
  }

  return {
    name: 'session_close',
    description: owned ? SESSION_CLOSE_DESCRIPTION_OWNED : SESSION_CLOSE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties,
      required: ['session_id'],
    },
    output: {
      schema: { type: 'string' },
      render: RENDER_TEXT,
    },
    async execute(args, exec) {
      try {
        return await executeSessionClose(ctx, args, exec, permissionMode)
      } catch (error) {
        return toErrorText(error)
      }
    },
  }
}

function createSessionOpenTool(ctx) {
  return {
    name: 'session_open',
    description: SESSION_OPEN_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session id to restore from the archive.',
        },
      },
      required: ['session_id'],
    },
    output: {
      schema: { type: 'string' },
      render: RENDER_TEXT,
    },
    async execute(args) {
      try {
        return await executeSessionOpen(ctx, args)
      } catch (error) {
        return toErrorText(error)
      }
    },
  }
}

async function executeSessionUpdate(ctx, rawArgs, exec, permissionMode) {
  const args = rawArgs ?? {}
  const controller = requireController(ctx)

  const sessionId = nonEmptyString(args.session_id)
  if (sessionId === '') return 'session-hub: session_id is required'

  if (permissionMode === 'owned') {
    const callerId = callerIdOf(exec)
    const ownerId = await ownerOf(sessionId)
    // `confirm` only counts when it is the boolean true; "true", 1 and the like
    // must not be accepted as authorization.
    if (confirmRequired(ownerId, callerId) && args.confirm !== true) {
      return confirmError(sessionId)
    }
  }

  const title = nonEmptyString(args.title)
  const wantsModel = hasModelRequest(args)
  if (title === '' && !wantsModel) return 'session-hub: nothing to update'

  // Resolve the model before applying anything: a resolution failure must not
  // leave a half-applied update behind. Resolution performs no side effects.
  const resolution = wantsModel ? await resolveModelSelection(controller, args) : null
  const modelError = resolution?.error ?? null

  // A model-only request with an unresolvable model has no successful change
  // to report, so surface the resolution error verbatim.
  if (title === '' && modelError !== null) return modelError

  const lines = [`已更新会话 ${sessionId}`]

  if (title !== '') {
    try {
      await controller.rename({ sessionId, title })
      lines.push(`- title: ${title}`)
    } catch (error) {
      lines.push(`- title: 失败（${errorMessage(error)}）`)
    }
  }

  if (wantsModel) {
    if (modelError !== null) {
      // The title (if any) was already applied above; report both outcomes so
      // the caller does not read a partial update as a total failure.
      lines.push(`- model: 失败（${modelError}）`)
    } else {
      const selection = resolution.selection
      try {
        await controller.selectModel({ sessionId, ...selection })
        lines.push(`- model: ${formatSelection(selection)}`)
      } catch (error) {
        lines.push(`- model: 失败（${errorMessage(error)}）`)
      }
    }
  }

  return lines.join('\n')
}

async function executeSessionClose(ctx, rawArgs, exec, permissionMode) {
  const args = rawArgs ?? {}
  const sessionId = nonEmptyString(args.session_id)
  if (sessionId === '') return 'session-hub: session_id is required'

  const callerId = callerIdOf(exec)
  // Self-close is decided first, before any confirmation check. Permissive
  // mode has no confirm escape hatch, so the call is refused outright; owned
  // mode keeps the existing explicit-confirmation path.
  const isSelf = callerId !== '' && sessionId === callerId
  if (isSelf) {
    if (permissionMode === 'permissive') return SELF_CLOSE_ERROR
    if (args.confirm !== true) return confirmError(sessionId)
  } else if (permissionMode === 'owned') {
    const ownerId = await ownerOf(sessionId)
    if (confirmRequired(ownerId, callerId) && args.confirm !== true) {
      return confirmError(sessionId)
    }
  }

  const workspaceController = requireWorkspaceController(ctx)
  try {
    await workspaceController.archiveSession({ sessionId, stopActivity: true })
  } catch (error) {
    return `session-hub: close failed: ${errorMessage(error)}`
  }

  return `已关闭会话 ${sessionId}（已归档，可用 session_open 恢复）`
}

async function executeSessionOpen(ctx, rawArgs) {
  const args = rawArgs ?? {}
  const sessionId = nonEmptyString(args.session_id)
  if (sessionId === '') return 'session-hub: session_id is required'

  const workspaceController = requireWorkspaceController(ctx)
  try {
    await workspaceController.unarchiveSession({ sessionId })
  } catch (error) {
    return `session-hub: open failed: ${errorMessage(error)}`
  }

  return `已恢复会话 ${sessionId}`
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

/**
 * Render the selected model, including the reasoning effort when set.
 *
 * @param {{provider: string, model: string, reasoningEffort?: string}} selection
 * @returns {string}
 */
function formatSelection(selection) {
  const base = `${selection.provider}/${selection.model}`
  return selection.reasoningEffort === undefined ? base : `${base} (${selection.reasoningEffort})`
}

function callerIdOf(exec) {
  return typeof exec?.agent?.id === 'string' ? exec.agent.id.trim() : ''
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
