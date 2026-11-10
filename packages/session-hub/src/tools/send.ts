/**
 * Messaging session tools: `session_send`, `session_wake`, `session_wait`.
 *
 * The three tools are deliberately separate, mirroring the host's own
 * vocabulary: send only delivers, wake asks the target to process the message
 * now, and wait only waits for idle. Authorization is enforced here against
 * the plugin's owner index and the tool's own resolved policy before any host
 * action.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { ResolvedSettings, ResolvedToolPolicy } from '../config/resolve.js'
import { authorizeTarget } from '../domain/authorization.js'
import { clampTimeout, deliver, waitForIdle, wake } from '../domain/messaging.js'
import { renderText, renderWait } from '../format/renders.js'
import { readArchivedIds } from '../host/session-access.js'
import { asToolArgs, stringArg } from '../shared/args.js'
import { ErrorCode, ToolName } from '../shared/enums.js'
import { sessionHubError, sessionHubText, toErrorText } from '../shared/errors.js'
import { callerIdOf } from '../shared/exec.js'
import { MIN_TIMEOUT_MS } from '../shared/limits.js'
import type {
  AuthorizedTarget,
  AuthorizationResult,
  HostContext,
  ToolArgs,
  ToolExecContext,
} from '../shared/types.js'

const SESSION_SEND_DESCRIPTION = [
  'Deliver a message to another DeepSeek Harness session without waking it.',
  'The message is injected and the target is not started, and no reply is returned.',
  'Use session_wake when the target should process the message now.',
].join(' ')

const SESSION_WAKE_DESCRIPTION = [
  'Ask another DeepSeek Harness session to process a message now.',
  'A running session is steered at its next step boundary; an idle session gets a follow-up turn.',
].join(' ')

const SESSION_WAIT_DESCRIPTION = [
  'Wait for another DeepSeek Harness session to become idle and return its latest assistant reply.',
  'An archived session and a session that is not loaded return immediately. This tool never asks for confirmation unless configured.',
].join(' ')

const SELF_TARGET_DESCRIPTION = 'Sending to itself is refused.'
const ARCHIVED_DESCRIPTION = 'An archived target must be restored with session_open first.'

/** Build the messaging session tools bound to a host context and config. */
export function createSendTools(ctx: HostContext, settings: ResolvedSettings): ToolDefinition[] {
  return [
    createSessionSendTool(ctx, settings.tools[ToolName.SessionSend]),
    createSessionWakeTool(ctx, settings.tools[ToolName.SessionWake]),
    createSessionWaitTool(ctx, settings.tools[ToolName.SessionWait]),
  ]
}

function createSessionSendTool(ctx: HostContext, policy: ResolvedToolPolicy): ToolDefinition {
  return {
    name: ToolName.SessionSend,
    description: messageDescription(SESSION_SEND_DESCRIPTION, policy),
    parameters: {
      type: 'object',
      properties: messageProperties(policy, 'send to'),
      required: ['session_id', 'message'],
    },
    output: {
      schema: { type: 'string' },
      render: renderText,
    },
    async execute(rawArgs, exec) {
      try {
        return await executeSessionSend(ctx, rawArgs, exec, policy)
      } catch (error) {
        return toErrorText(error)
      }
    },
  } satisfies ToolDefinition
}

function createSessionWakeTool(ctx: HostContext, policy: ResolvedToolPolicy): ToolDefinition {
  return {
    name: ToolName.SessionWake,
    description: messageDescription(SESSION_WAKE_DESCRIPTION, policy),
    parameters: {
      type: 'object',
      properties: messageProperties(policy, 'wake'),
      required: ['session_id', 'message'],
    },
    output: {
      schema: { type: 'string' },
      render: renderText,
    },
    async execute(rawArgs, exec) {
      try {
        return await executeSessionWake(ctx, rawArgs, exec, policy)
      } catch (error) {
        return toErrorText(error)
      }
    },
  } satisfies ToolDefinition
}

function createSessionWaitTool(ctx: HostContext, policy: ResolvedToolPolicy): ToolDefinition {
  const properties: Record<string, unknown> = {
    session_id: {
      type: 'string',
      description: 'Session id to wait for.',
    },
    timeout_ms: {
      type: 'integer',
      description: `Maximum wait in milliseconds (default ${policy.timeoutMaxMs}, clamped to ${MIN_TIMEOUT_MS}..${policy.timeoutMaxMs}).`,
      default: policy.timeoutMaxMs,
    },
  }
  if (policy.confirm !== 'never') {
    properties.confirm = {
      type: 'boolean',
      description:
        policy.confirm === 'always'
          ? 'Must be true to wait on any session.'
          : 'Must be true to wait on a session the caller did not create.',
    }
  }

  return {
    name: ToolName.SessionWait,
    description: SESSION_WAIT_DESCRIPTION,
    parameters: {
      type: 'object',
      properties,
      required: ['session_id'],
    },
    output: {
      schema: { type: 'string' },
      render: renderText,
    },
    async execute(rawArgs, exec) {
      try {
        return await executeSessionWait(ctx, rawArgs, exec, policy)
      } catch (error) {
        return toErrorText(error)
      }
    },
  } satisfies ToolDefinition
}

/** The shared parameter set of send and wake. */
function messageProperties(
  policy: ResolvedToolPolicy,
  verb: string,
): Record<string, unknown> {
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
  if (policy.confirm !== 'never') {
    properties.confirm = {
      type: 'boolean',
      description:
        policy.confirm === 'always'
          ? `Must be true to ${verb} any session.`
          : `Must be true to ${verb} a session the caller did not create.`,
    }
  }
  return properties
}

/** Append the policy-dependent guidance to a static description. */
function messageDescription(base: string, policy: ResolvedToolPolicy): string {
  const parts = [base]
  if (!policy.allowSelf) parts.push(SELF_TARGET_DESCRIPTION)
  if (!policy.allowArchived) parts.push(ARCHIVED_DESCRIPTION)
  if (policy.confirm === 'non-owned') {
    parts.push('Acting on a session the caller did not create requires confirm: true.')
  } else if (policy.confirm === 'always') {
    parts.push('Every call requires confirm: true.')
  }
  return parts.join(' ')
}

async function executeSessionSend(
  ctx: HostContext,
  rawArgs: unknown,
  exec: ToolExecContext,
  policy: ResolvedToolPolicy,
): Promise<string> {
  const args = asToolArgs(rawArgs)

  const sessionId = stringArg(args, 'session_id')
  if (sessionId === '') return sessionHubText('session_id is required')
  const message = stringArg(args, 'message')
  if (message === '') return sessionHubText('message is required')

  const target = await authorizedTarget(ctx, sessionId, args, exec, policy, policy.allowSelf, true)
  if ('error' in target) return target.error

  const result = await deliver(ctx, {
    sessionId,
    text: message,
    senderId: target.callerId,
    attribution: policy.attribution,
  })
  return result.text
}

async function executeSessionWake(
  ctx: HostContext,
  rawArgs: unknown,
  exec: ToolExecContext,
  policy: ResolvedToolPolicy,
): Promise<string> {
  const args = asToolArgs(rawArgs)

  const sessionId = stringArg(args, 'session_id')
  if (sessionId === '') return sessionHubText('session_id is required')
  const message = stringArg(args, 'message')
  if (message === '') return sessionHubText('message is required')

  const target = await authorizedTarget(ctx, sessionId, args, exec, policy, policy.allowSelf, true)
  if ('error' in target) return target.error

  const result = await wake(ctx, {
    sessionId,
    text: message,
    senderId: target.callerId,
    attribution: policy.attribution,
    whenRunning: policy.whenRunning,
  })
  return result.text
}

async function executeSessionWait(
  ctx: HostContext,
  rawArgs: unknown,
  exec: ToolExecContext,
  policy: ResolvedToolPolicy,
): Promise<string> {
  const args = asToolArgs(rawArgs)

  const sessionId = stringArg(args, 'session_id')
  if (sessionId === '') return sessionHubText('session_id is required')

  const target = await authorizedTarget(ctx, sessionId, args, exec, policy, true, false)
  if ('error' in target) return target.error

  const timeoutMs = effectiveTimeout(policy, args.timeout_ms)
  const result = await waitForIdle(ctx, sessionId, timeoutMs, { readReply: policy.reply })
  return renderWait(sessionId, result.status, timeoutMs, result.reply, policy.replyMaxChars)
}

/**
 * Validate the parts shared by send, wake and wait, in the documented order:
 * self-target (`allowSelf`), ownership (`targets`), `confirm`, then the
 * archive gate (`allowArchived`) for the two tools that deliver messages.
 */
async function authorizedTarget(
  ctx: HostContext,
  sessionId: string,
  args: ToolArgs,
  exec: ToolExecContext,
  policy: ResolvedToolPolicy,
  allowSelf: boolean,
  enforceArchive: boolean,
): Promise<AuthorizationResult> {
  const callerId = callerIdOf(exec)

  const denial = await authorizeTarget({
    sessionId,
    callerId,
    targets: policy.targets,
    confirm: policy.confirm,
    allowSelf,
    confirmGiven: args.confirm,
    selfError: sessionHubError(ErrorCode.SelfTarget, 'a session cannot send a message to itself'),
  })
  if ('error' in denial) return { error: denial.error }

  if (enforceArchive && !policy.allowArchived && readArchivedIds(ctx).includes(sessionId)) {
    return {
      error: sessionHubError(
        ErrorCode.SessionArchived,
        `session "${sessionId}" is archived; call session_open first`,
      ),
    }
  }

  const authorizedTarget: AuthorizedTarget = { sessionId, callerId }
  return authorizedTarget
}

/** Clamp the requested wait budget into `[MIN_TIMEOUT_MS, timeoutMaxMs]`. */
function effectiveTimeout(policy: ResolvedToolPolicy, raw: unknown): number {
  const cap = policy.timeoutMaxMs
  const requested = raw === undefined || raw === null || raw === '' ? cap : clampTimeout(raw)
  return Math.min(cap, Math.max(MIN_TIMEOUT_MS, requested))
}
