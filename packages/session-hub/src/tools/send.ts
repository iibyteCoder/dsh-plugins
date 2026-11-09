/**
 * Messaging session tools: `session_send`, `session_wake`, `session_wait`.
 *
 * The three tools are deliberately separate, mirroring the host's own
 * vocabulary: send only delivers, wake asks the target to process the message
 * now, and wait only waits for idle. Authorization is enforced here against
 * the plugin's owner index before any host action.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { confirmError, confirmRequired, ownerOf } from '../domain/ownership.js'
import { clampTimeout, deliver, waitForIdle, wake } from '../domain/messaging.js'
import { renderText, renderWait } from '../format/renders.js'
import { readArchivedIds } from '../host/session-access.js'
import { asToolArgs, stringArg } from '../shared/args.js'
import { ErrorCode, PermissionMode, ToolName } from '../shared/enums.js'
import { sessionHubError, sessionHubText, toErrorText } from '../shared/errors.js'
import { DEFAULT_TIMEOUT_MS } from '../shared/limits.js'
import type {
  AuthorizedTarget,
  AuthorizationResult,
  HostContext,
  ToolArgs,
  ToolExecContext,
  ToolOptions,
} from '../shared/types.js'

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

/** Build the messaging session tools bound to a host context. */
export function createSendTools(
  ctx: HostContext,
  options: ToolOptions = { permissionMode: PermissionMode.Permissive },
): ToolDefinition[] {
  return [
    createSessionSendTool(ctx, options.permissionMode),
    createSessionWakeTool(ctx, options.permissionMode),
    createSessionWaitTool(ctx),
  ]
}

function createSessionSendTool(ctx: HostContext, permissionMode: PermissionMode): ToolDefinition {
  const owned = permissionMode === PermissionMode.Owned
  return {
    name: ToolName.SessionSend,
    description: owned ? SESSION_SEND_DESCRIPTION_OWNED : SESSION_SEND_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: messageProperties(owned, 'send to'),
      required: ['session_id', 'message'],
    },
    output: {
      schema: { type: 'string' },
      render: renderText,
    },
    async execute(rawArgs, exec) {
      try {
        return await executeSessionSend(ctx, rawArgs, exec, permissionMode)
      } catch (error) {
        return toErrorText(error)
      }
    },
  } satisfies ToolDefinition
}

function createSessionWakeTool(ctx: HostContext, permissionMode: PermissionMode): ToolDefinition {
  const owned = permissionMode === PermissionMode.Owned
  return {
    name: ToolName.SessionWake,
    description: owned ? SESSION_WAKE_DESCRIPTION_OWNED : SESSION_WAKE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: messageProperties(owned, 'wake'),
      required: ['session_id', 'message'],
    },
    output: {
      schema: { type: 'string' },
      render: renderText,
    },
    async execute(rawArgs, exec) {
      try {
        return await executeSessionWake(ctx, rawArgs, exec, permissionMode)
      } catch (error) {
        return toErrorText(error)
      }
    },
  } satisfies ToolDefinition
}

function createSessionWaitTool(ctx: HostContext): ToolDefinition {
  return {
    name: ToolName.SessionWait,
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
          default: DEFAULT_TIMEOUT_MS,
        },
      },
      required: ['session_id'],
    },
    output: {
      schema: { type: 'string' },
      render: renderText,
    },
    async execute(rawArgs) {
      try {
        return await executeSessionWait(ctx, rawArgs)
      } catch (error) {
        return toErrorText(error)
      }
    },
  } satisfies ToolDefinition
}

/**
 * The shared parameter set of send and wake; `confirm` only exists in owned
 * mode.
 */
function messageProperties(owned: boolean, verb: string): Record<string, unknown> {
  const properties: Record<string, unknown> = {
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

async function executeSessionSend(
  ctx: HostContext,
  rawArgs: unknown,
  exec: ToolExecContext,
  permissionMode: PermissionMode,
): Promise<string> {
  const args = asToolArgs(rawArgs)

  const sessionId = stringArg(args, 'session_id')
  if (sessionId === '') return sessionHubText('session_id is required')
  const message = stringArg(args, 'message')
  if (message === '') return sessionHubText('message is required')

  const target = await authorizedTarget(ctx, sessionId, args, exec, permissionMode)
  if ('error' in target) return target.error

  const result = await deliver(ctx, { sessionId, text: message, senderId: target.callerId })
  return result.text
}

async function executeSessionWake(
  ctx: HostContext,
  rawArgs: unknown,
  exec: ToolExecContext,
  permissionMode: PermissionMode,
): Promise<string> {
  const args = asToolArgs(rawArgs)

  const sessionId = stringArg(args, 'session_id')
  if (sessionId === '') return sessionHubText('session_id is required')
  const message = stringArg(args, 'message')
  if (message === '') return sessionHubText('message is required')

  const target = await authorizedTarget(ctx, sessionId, args, exec, permissionMode)
  if ('error' in target) return target.error

  const result = await wake(ctx, { sessionId, text: message, senderId: target.callerId })
  return result.text
}

async function executeSessionWait(ctx: HostContext, rawArgs: unknown): Promise<string> {
  const args = asToolArgs(rawArgs)

  const sessionId = stringArg(args, 'session_id')
  if (sessionId === '') return sessionHubText('session_id is required')

  const timeoutMs = clampTimeout(args.timeout_ms)
  const result = await waitForIdle(ctx, sessionId, timeoutMs)
  return renderWait(sessionId, result.status, timeoutMs, result.reply)
}

/**
 * Validate the parts shared by send and wake, in the documented order:
 * self-target, ownership (owned mode only), archive gate.
 */
async function authorizedTarget(
  ctx: HostContext,
  sessionId: string,
  args: ToolArgs,
  exec: ToolExecContext,
  permissionMode: PermissionMode,
): Promise<AuthorizationResult> {
  const callerId = callerIdOf(exec)

  // A session messaging itself has no meaningful turn to wake; refuse before
  // any ownership lookup or agent resolution.
  if (sessionId === callerId) {
    return {
      error: sessionHubError(ErrorCode.SelfTarget, 'a session cannot send a message to itself'),
    }
  }

  if (permissionMode === PermissionMode.Owned) {
    const ownerId = await ownerOf(sessionId)
    // `confirm` only counts when it is the boolean true; "true", 1 and the like
    // must not be accepted as authorization.
    if (confirmRequired(ownerId, callerId) && args.confirm !== true) {
      return { error: confirmError(sessionId) }
    }
  }

  if (readArchivedIds(ctx).includes(sessionId)) {
    return {
      error: sessionHubError(
        ErrorCode.SessionArchived,
        `session "${sessionId}" is archived; call session_open first`,
      ),
    }
  }

  const authorized: AuthorizedTarget = { sessionId, callerId }
  return authorized
}

function callerIdOf(exec: ToolExecContext): string {
  return typeof exec.agent?.id === 'string' ? exec.agent.id.trim() : ''
}
