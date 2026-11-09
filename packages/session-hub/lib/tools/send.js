/**
 * Communication session tools: `session_send` and `session_interrupt`.
 *
 * Authorization is enforced here against the plugin's owner index before any
 * host action, mirroring the other mutating tools: a target the caller did not
 * create needs explicit `confirm: true`. Failures are rendered as
 * `session-hub: ...` text so a misbehaving call cannot take down the agent.
 */
import { confirmError, confirmRequired, ownerOf } from '../control.js'
import { readArchivedIds, sendToSession } from '../messaging.js'
import { requireController } from '../services.js'

const RENDER_TEXT = (_args, value) => [{ type: 'text', text: String(value ?? '') }]

const SESSION_SEND_DESCRIPTION = [
  'Send a message from the calling session to another DeepSeek Harness session.',
  'mode "queue" (default) queues it for the next turn; mode "steer" delivers it at the next step.',
  'wait: true waits for the target to become idle and returns its latest reply.',
  'Sending to a session the caller did not create requires confirm: true; sending to itself is refused.',
].join(' ')

const SESSION_INTERRUPT_DESCRIPTION = [
  'Interrupt the current turn of a DeepSeek Harness session, keeping its inbox.',
  'Interrupting a session the caller did not create requires confirm: true.',
].join(' ')

/**
 * Build the communication session tools bound to a host context.
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @returns {object[]} Tool definitions ready for `ctx.tools.register`.
 */
export function createSendTools(ctx) {
  return [createSessionSendTool(ctx), createSessionInterruptTool(ctx)]
}

function createSessionSendTool(ctx) {
  return {
    name: 'session_send',
    description: SESSION_SEND_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session id to send the message to.',
        },
        message: {
          type: 'string',
          description: 'Message text to deliver.',
        },
        mode: {
          type: 'string',
          description: 'queue delivers on the next turn; steer delivers at the next step.',
          enum: ['queue', 'steer'],
          default: 'queue',
        },
        wait: {
          type: 'boolean',
          description: 'Wait for the target session to become idle and return its latest reply.',
          default: false,
        },
        timeout_ms: {
          type: 'integer',
          description: 'Maximum wait in milliseconds when wait is true (default 120000, clamped to 1000..600000).',
          default: 120000,
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to send to a session the caller did not create.',
        },
      },
      required: ['session_id', 'message'],
    },
    output: {
      schema: { type: 'string' },
      render: RENDER_TEXT,
    },
    async execute(args, exec) {
      try {
        return await executeSessionSend(ctx, args, exec)
      } catch (error) {
        return toErrorText(error)
      }
    },
  }
}

function createSessionInterruptTool(ctx) {
  return {
    name: 'session_interrupt',
    description: SESSION_INTERRUPT_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session id to interrupt.',
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to interrupt a session the caller did not create.',
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
        return await executeSessionInterrupt(ctx, args, exec)
      } catch (error) {
        return toErrorText(error)
      }
    },
  }
}

async function executeSessionSend(ctx, rawArgs, exec) {
  const args = rawArgs ?? {}

  const sessionId = nonEmptyString(args.session_id)
  if (sessionId === '') return 'session-hub: session_id is required'
  const message = nonEmptyString(args.message)
  if (message === '') return 'session-hub: message is required'

  const callerId = callerIdOf(exec)
  // A session messaging itself has no meaningful turn to wake; refuse before
  // any ownership lookup or agent resolution.
  if (sessionId === callerId) {
    return 'session-hub: SELF_TARGET: a session cannot send a message to itself'
  }

  const ownerId = await ownerOf(sessionId)
  if (confirmRequired(ownerId, callerId) && args.confirm !== true) {
    return confirmError(sessionId)
  }

  if (readArchivedIds(ctx).includes(sessionId)) {
    return `session-hub: SESSION_ARCHIVED: session "${sessionId}" is archived; call session_open first`
  }

  const result = await sendToSession(ctx, {
    sessionId,
    text: message,
    mode: args.mode === 'steer' ? 'steer' : 'queue',
    wait: args.wait === true,
    timeoutMs: args.timeout_ms,
    senderId: callerId,
  })
  return result.text
}

async function executeSessionInterrupt(ctx, rawArgs, exec) {
  const args = rawArgs ?? {}

  const sessionId = nonEmptyString(args.session_id)
  if (sessionId === '') return 'session-hub: session_id is required'

  const callerId = callerIdOf(exec)
  const ownerId = await ownerOf(sessionId)
  if (confirmRequired(ownerId, callerId) && args.confirm !== true) {
    return confirmError(sessionId)
  }

  const controller = requireController(ctx)
  try {
    await controller.cancel({ sessionId })
  } catch (error) {
    return `session-hub: interrupt failed: ${errorMessage(error)}`
  }

  return `已打断会话 ${sessionId}`
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
