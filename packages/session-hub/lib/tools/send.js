/**
 * Messaging session tools: `session_send`, `session_wake`, `session_wait`.
 *
 * The three tools are deliberately separate, mirroring the host's own
 * vocabulary: send only delivers (it never wakes the target and never returns
 * a reply), wake asks the target to process the message now, and wait only
 * waits for idle. Authorization is enforced here against the plugin's owner
 * index before any host action; failures are rendered as `session-hub: ...`
 * text so a misbehaving call cannot take down the agent.
 */
import { confirmError, confirmRequired, ownerOf } from '../control.js'
import { clampTimeout, deliver, readArchivedIds, waitForIdle, wake } from '../messaging.js'

const RENDER_TEXT = (_args, value) => [{ type: 'text', text: String(value ?? '') }]

const SELF_TARGET_ERROR = 'session-hub: SELF_TARGET: a session cannot send a message to itself'

const SESSION_SEND_DESCRIPTION = [
  'Deliver a message to another DeepSeek Harness session without waking it.',
  'The message is injected and the target is not started, and no reply is returned.',
  'Use session_wake when the target should process the message now.',
  'Sending to itself is refused.',
].join(' ')

const SESSION_SEND_DESCRIPTION_OWNED = [
  SESSION_SEND_DESCRIPTION,
  'Sending to a session the caller did not create requires confirm: true.',
].join(' ')

const SESSION_WAKE_DESCRIPTION = [
  'Ask another DeepSeek Harness session to process a message now.',
  'A running session is steered at its next step boundary; an idle session gets a follow-up turn.',
  'Sending to itself is refused.',
].join(' ')

const SESSION_WAKE_DESCRIPTION_OWNED = [
  SESSION_WAKE_DESCRIPTION,
  'Waking a session the caller did not create requires confirm: true.',
].join(' ')

const SESSION_WAIT_DESCRIPTION = [
  'Wait for another DeepSeek Harness session to become idle and return its latest assistant reply (truncated to 2000 characters).',
  'An archived session and a session that is not loaded return immediately. This tool needs no confirmation.',
].join(' ')

/**
 * Build the messaging session tools bound to a host context.
 *
 * The permission mode is normalized by `lib/config.js` when the plugin is
 * applied. Only `session_send` and `session_wake` expose `confirm`, and only
 * in owned mode; `session_wait` is read-only and never asks for confirmation.
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @param {{permissionMode?: 'permissive' | 'owned'}} [options]
 * @returns {object[]} Tool definitions ready for `ctx.tools.register`.
 */
export function createSendTools(ctx, { permissionMode = 'permissive' } = {}) {
  return [
    createSessionSendTool(ctx, permissionMode),
    createSessionWakeTool(ctx, permissionMode),
    createSessionWaitTool(ctx),
  ]
}

function createSessionSendTool(ctx, permissionMode) {
  const owned = permissionMode === 'owned'
  return {
    name: 'session_send',
    description: owned ? SESSION_SEND_DESCRIPTION_OWNED : SESSION_SEND_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: messageProperties(owned, 'send to'),
      required: ['session_id', 'message'],
    },
    output: {
      schema: { type: 'string' },
      render: RENDER_TEXT,
    },
    async execute(args, exec) {
      try {
        return await executeSessionSend(ctx, args, exec, permissionMode)
      } catch (error) {
        return toErrorText(error)
      }
    },
  }
}

function createSessionWakeTool(ctx, permissionMode) {
  const owned = permissionMode === 'owned'
  return {
    name: 'session_wake',
    description: owned ? SESSION_WAKE_DESCRIPTION_OWNED : SESSION_WAKE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: messageProperties(owned, 'wake'),
      required: ['session_id', 'message'],
    },
    output: {
      schema: { type: 'string' },
      render: RENDER_TEXT,
    },
    async execute(args, exec) {
      try {
        return await executeSessionWake(ctx, args, exec, permissionMode)
      } catch (error) {
        return toErrorText(error)
      }
    },
  }
}

function createSessionWaitTool(ctx) {
  return {
    name: 'session_wait',
    description: SESSION_WAIT_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session id to wait for.',
        },
        timeout_ms: {
          type: 'integer',
          description: 'Maximum wait in milliseconds (default 120000, clamped to 1000..600000).',
          default: 120000,
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
        return await executeSessionWait(ctx, args)
      } catch (error) {
        return toErrorText(error)
      }
    },
  }
}

/**
 * The shared parameter set of send and wake; `confirm` only exists in owned
 * mode.
 *
 * @param {boolean} owned
 * @param {string} verb - Used in the confirm description.
 * @returns {object}
 */
function messageProperties(owned, verb) {
  const properties = {
    session_id: {
      type: 'string',
      description: 'Session id to target.',
    },
    message: {
      type: 'string',
      description: 'Message text to deliver.',
    },
  }
  if (owned) {
    properties.confirm = {
      type: 'boolean',
      description: `Must be true to ${verb} a session the caller did not create.`,
    }
  }
  return properties
}

async function executeSessionSend(ctx, rawArgs, exec, permissionMode) {
  const args = rawArgs ?? {}

  const sessionId = nonEmptyString(args.session_id)
  if (sessionId === '') return 'session-hub: session_id is required'
  const message = nonEmptyString(args.message)
  if (message === '') return 'session-hub: message is required'

  const target = await authorizedTarget(ctx, sessionId, args, exec, permissionMode)
  if (target.error !== undefined) return target.error

  const result = await deliver(ctx, { sessionId, text: message, senderId: target.callerId })
  return result.text
}

async function executeSessionWake(ctx, rawArgs, exec, permissionMode) {
  const args = rawArgs ?? {}

  const sessionId = nonEmptyString(args.session_id)
  if (sessionId === '') return 'session-hub: session_id is required'
  const message = nonEmptyString(args.message)
  if (message === '') return 'session-hub: message is required'

  const target = await authorizedTarget(ctx, sessionId, args, exec, permissionMode)
  if (target.error !== undefined) return target.error

  const result = await wake(ctx, { sessionId, text: message, senderId: target.callerId })
  return result.text
}

async function executeSessionWait(ctx, rawArgs) {
  const args = rawArgs ?? {}

  const sessionId = nonEmptyString(args.session_id)
  if (sessionId === '') return 'session-hub: session_id is required'

  const timeoutMs = clampTimeout(args.timeout_ms)
  const result = await waitForIdle(ctx, sessionId, timeoutMs)

  if (result.status === 'archived') return `会话 ${sessionId} 已归档，不会运行`
  if (result.status === 'cold') return `会话 ${sessionId} 空闲（未加载）`
  if (result.status === 'timeout') {
    return `session-hub: WAIT_TIMEOUT: session "${sessionId}" did not become idle within ${timeoutMs}ms`
  }

  const idle = `会话 ${sessionId} 已空闲`
  return result.reply === '' ? idle : `${idle}\n- reply: ${result.reply}`
}

/**
 * Validate the parts shared by send and wake, in the documented order:
 * self-target, ownership (owned mode only), archive gate.
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @param {string} sessionId - Already validated non-empty target.
 * @param {object} args - Raw tool arguments.
 * @param {object} exec - Tool execution context.
 * @param {'permissive' | 'owned'} permissionMode
 * @returns {Promise<{sessionId: string, callerId: string, error?: undefined} | {error: string}>}
 */
async function authorizedTarget(ctx, sessionId, args, exec, permissionMode) {
  const callerId = callerIdOf(exec)

  // A session messaging itself has no meaningful turn to wake; refuse before
  // any ownership lookup or agent resolution.
  if (sessionId === callerId) return { error: SELF_TARGET_ERROR }

  if (permissionMode === 'owned') {
    const ownerId = await ownerOf(sessionId)
    // `confirm` only counts when it is the boolean true; "true", 1 and the like
    // must not be accepted as authorization.
    if (confirmRequired(ownerId, callerId) && args.confirm !== true) {
      return { error: confirmError(sessionId) }
    }
  }

  if (readArchivedIds(ctx).includes(sessionId)) {
    return {
      error: `session-hub: SESSION_ARCHIVED: session "${sessionId}" is archived; call session_open first`,
    }
  }

  return { sessionId, callerId }
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
