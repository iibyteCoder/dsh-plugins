/**
 * Cross-session messaging primitives.
 *
 * The three operations mirror the host vocabulary one-to-one:
 *
 * - `deliver` — inject a message and return; the target is not woken and no
 *   reply is produced (`session_send`);
 * - `wake` — ask the target to process a message now, steering a running
 *   session at its next step boundary and following up on an idle one
 *   (`session_wake`, and the initial task of `session_create`);
 * - `waitForIdle` — wait for the target to become idle and read its latest
 *   assistant reply (`session_wait`).
 *
 * Message construction, agent resolution and wait/timeout handling live here
 * once so the tools only own validation and authorization.
 *
 * No `@deepseek-ai/*` module is imported at runtime: the user message is built
 * by hand with the host's shape so the plugin never shadows the host's copy.
 */
import { randomUUID } from 'node:crypto'

import type { AgentStatus } from '@deepseek-ai/dsh-agent'

import { requireController, serviceOf } from '../host/services.js'
import type { AgentResolution, AgentRegistry, TargetAgent } from '../host/contracts.js'
import {
  eventMessageText,
  lastAssistantEvent,
  readArchivedIds,
  readSessionSnapshot,
} from '../host/session-access.js'
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
} from '../shared/limits.js'
import {
  DeliveryMode,
  HostService,
  MessageKind,
  SessionStatus,
  WaitOutcome,
} from '../shared/enums.js'
import { errorMessage, sessionHubText } from '../shared/errors.js'
import type {
  AgentMessage,
  AgentMessageSource,
  DeliveryOptions,
  DeliveryResult,
  HostContext,
  WaitResult,
} from '../shared/types.js'

/** The host's running status literal, typed against the host vocabulary. */
const RUNNING_AGENT_STATUS: AgentStatus = 'running'

/** Successful agent resolution. */
export interface AgentResolved {  readonly agent: TargetAgent
  readonly error: null
}

/** Failed agent resolution, already rendered as text. */
export interface AgentResolveFailure {
  readonly error: string
}

export type AgentResolveResult = AgentResolved | AgentResolveFailure

/**
 * Build the host user-message shape, attributed to the sending session.
 *
 * A known sender is announced in the body and carried in `source`; an unknown
 * sender (missing caller id) produces the same kind of message without an
 * identity claim.
 */
export function buildAgentMessage(text: unknown, senderId = ''): AgentMessage {
  const sender = typeof senderId === 'string' ? senderId.trim() : ''
  const body = typeof text === 'string' ? text : String(text ?? '')
  const content = [
    { type: 'text' as const, text: sender === '' ? body : `Agent ${sender} sent a message:\n\n${body}` },
  ]

  const source: AgentMessageSource =
    sender === ''
      ? { kind: MessageKind.AgentMessage, form: 'relay' }
      : { kind: MessageKind.AgentMessage, form: 'relay', senderSessionId: sender }

  return { id: randomUUID(), role: 'user', content, source }
}

/**
 * Inject `text` into another session without waking it.
 *
 * Delivery failure is reported as text; only a missing host service throws
 * (the tool wrapper renders that as text too).
 */
export async function deliver(
  ctx: HostContext,
  options: DeliveryOptions,
): Promise<DeliveryResult> {
  const { sessionId, text, senderId = '' } = options
  const resolution = await resolveAgentFor(ctx, sessionId)
  if (resolution.error !== null) return { ok: false, text: resolution.error }

  try {
    await resolution.agent.inject(buildAgentMessage(text, senderId))
  } catch (error) {
    return { ok: false, text: sendFailure(errorMessage(error)) }
  }

  return { ok: true, text: `已向会话 ${sessionId} 投递消息（不唤醒）` }
}

/**
 * Ask another session to process `text`.
 *
 * A running target is steered, so the message is delivered at the next step
 * boundary instead of interrupting the current one; an idle target gets a
 * follow-up turn.
 */
export async function wake(ctx: HostContext, options: DeliveryOptions): Promise<DeliveryResult> {
  const { sessionId, text, senderId = '' } = options
  const resolution = await resolveAgentFor(ctx, sessionId)
  if (resolution.error !== null) return { ok: false, text: resolution.error }

  const agent = resolution.agent
  const running = agent.status === RUNNING_AGENT_STATUS
  const message = buildAgentMessage(text, senderId)

  try {
    if (running) {
      await agent.steer(message)
    } else {
      await agent.followup(message)
    }
  } catch (error) {
    return { ok: false, text: sendFailure(errorMessage(error)) }
  }

  const targetState = running ? SessionStatus.Running : SessionStatus.Idle
  const delivery = running ? DeliveryMode.Steer : DeliveryMode.Queue
  return { ok: true, text: `已请求会话 ${sessionId} 处理消息（${targetState} → ${delivery}）` }
}

/**
 * Wait for a session to become idle and read its latest assistant reply.
 *
 * An archived session can never run, and a session with no loaded agent has
 * nothing to wait for; both return immediately with a distinguishable status.
 * A timeout returns without touching the target.
 */
export async function waitForIdle(
  ctx: HostContext,
  sessionId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<WaitResult> {
  if (readArchivedIds(ctx).includes(sessionId)) {
    return { status: WaitOutcome.Archived, reply: '' }
  }

  const agent = readAgent(ctx, sessionId)
  if (agent === undefined || agent === null) {
    return { status: WaitOutcome.Cold, reply: '' }
  }

  const becameIdle = await raceIdle(agent, clampTimeout(timeoutMs))
  if (!becameIdle) return { status: WaitOutcome.Timeout, reply: '' }

  return { status: WaitOutcome.Idle, reply: await readLastAssistantText(ctx, sessionId) }
}

/**
 * The latest assistant message of a session, or `''` when it cannot be read.
 *
 * A wait already succeeded once the target is idle, so an unreadable reply is
 * reported as "no reply" rather than turning the wait into a failure. The read
 * goes through the session store or query service, never through inspection.
 */
export async function readLastAssistantText(
  ctx: HostContext,
  sessionId: string,
): Promise<string> {
  try {
    const snapshot = await readSessionSnapshot(ctx, sessionId)
    const message = lastAssistantEvent(snapshot.events)
    if (message === undefined) return ''
    return eventMessageText(message)
  } catch {
    return ''
  }
}

/**
 * Clamp a user-supplied timeout into the supported window.
 *
 * Exported so `session_wait` can report the exact budget it waited with; the
 * clamp itself stays a single rule in this module.
 */
export function clampTimeout(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_TIMEOUT_MS
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(number)))
}

/** Resolve the agent of a target session through the host controller. */
async function resolveAgentFor(
  ctx: HostContext,
  sessionId: string,
): Promise<AgentResolveResult> {
  const controller = requireController(ctx)

  let resolution: AgentResolution | undefined
  try {
    resolution = await controller.resolveAgent(sessionId)
  } catch (error) {
    return { error: sendFailure(errorMessage(error)) }
  }

  const resolveError = resolution?.error
  if (resolveError !== undefined && resolveError !== null) {
    const code = resolveError.code
    return { error: sendFailure(code ? String(code) : 'unknown') }
  }

  const agent = resolution?.agent
  if (agent === undefined || agent === null) {
    return { error: sendFailure('unknown') }
  }

  return { agent, error: null }
}

function readAgent(ctx: HostContext, sessionId: string): TargetAgent | undefined {
  try {
    const agents = serviceOf(ctx, HostService.Agents) as AgentRegistry | undefined
    return agents?.get?.(sessionId)
  } catch {
    return undefined
  }
}

/**
 * Wait for `agent.whenIdle()` to settle, or for the timeout to win.
 *
 * The timer is cleared as soon as the race settles. A rejecting `whenIdle` is
 * treated as "did not become idle": the wait is over either way, and reporting
 * a timeout is the least misleading outcome available. An agent without
 * `whenIdle` is considered idle, since there is nothing to wait for.
 */
async function raceIdle(agent: TargetAgent, timeoutMs: number): Promise<boolean> {
  if (typeof agent.whenIdle !== 'function') return true

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  const idle = Promise.resolve()
    .then(() => agent.whenIdle?.())
    .then(
      () => true,
      () => false,
    )

  try {
    return await Promise.race([idle, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function sendFailure(detail: string): string {
  return sessionHubText(`send failed: ${detail}`)
}
