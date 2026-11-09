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
 * once so the tools only own validation and authorization, and the three
 * artifacts cannot drift apart on what "delivered" or "idle" means.
 *
 * No `@deepseek-ai/*` module is imported: the user message is built by hand
 * with the host's shape so the plugin never shadows the host's own copy.
 */
import { randomUUID } from 'node:crypto'

import { truncateText } from './format.js'
import { requireController, serviceOf } from './services.js'

const DEFAULT_TIMEOUT_MS = 120000
const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 600000
const MAX_REPLY_CHARS = 2000

/**
 * Build the host user-message shape, attributed to the sending session.
 *
 * A known sender is announced in the body and carried in `source`; an unknown
 * sender (missing caller id) produces the same kind of message without an
 * identity claim.
 *
 * @param {unknown} text
 * @param {string} [senderId]
 * @returns {{id: string, role: 'user', content: {type: 'text', text: string}[], source: {kind: string, form: string, senderSessionId?: string}}}
 */
export function buildAgentMessage(text, senderId) {
  const sender = typeof senderId === 'string' ? senderId.trim() : ''
  const body = typeof text === 'string' ? text : String(text ?? '')
  const content = [{ type: 'text', text: sender === '' ? body : `Agent ${sender} sent a message:\n\n${body}` }]

  const source = { kind: 'agent-message', form: 'relay' }
  if (sender !== '') source.senderSessionId = sender

  return { id: randomUUID(), role: 'user', content, source }
}

/**
 * Inject `text` into another session without waking it.
 *
 * Delivery failure is reported as text, like the rest of the mutating tools;
 * only a missing host service throws (the tool wrapper renders that as text
 * too).
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @param {{sessionId: string, text: string, senderId?: string}} options
 * @returns {Promise<{ok: boolean, text: string}>}
 */
export async function deliver(ctx, { sessionId, text, senderId = '' } = {}) {
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
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @param {{sessionId: string, text: string, senderId?: string}} options
 * @returns {Promise<{ok: boolean, text: string}>}
 */
export async function wake(ctx, { sessionId, text, senderId = '' } = {}) {
  const resolution = await resolveAgentFor(ctx, sessionId)
  if (resolution.error !== null) return { ok: false, text: resolution.error }

  const agent = resolution.agent
  const running = agent.status === 'running'
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

  const targetState = running ? 'running' : 'idle'
  const delivery = running ? 'steer' : 'followup'
  return { ok: true, text: `已请求会话 ${sessionId} 处理消息（${targetState} → ${delivery}）` }
}

/**
 * Wait for a session to become idle and read its latest assistant reply.
 *
 * An archived session can never run, and a session with no loaded agent has
 * nothing to wait for; both return immediately with a distinguishable status
 * so `session_wait` can explain the outcome. A timeout returns without
 * touching the target.
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @param {string} sessionId
 * @param {number} [timeoutMs] - Clamped into 1000..600000.
 * @returns {Promise<{status: 'archived'|'cold'|'timeout'|'idle', reply: string}>}
 */
export async function waitForIdle(ctx, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (readArchivedIds(ctx).includes(sessionId)) return { status: 'archived', reply: '' }

  const agent = readAgent(ctx, sessionId)
  if (agent === undefined || agent === null) return { status: 'cold', reply: '' }

  const becameIdle = await raceIdle(agent, clampTimeout(timeoutMs))
  if (!becameIdle) return { status: 'timeout', reply: '' }

  return { status: 'idle', reply: await readLastAssistantText(ctx, sessionId) }
}

/**
 * The session ids the workspace registry currently reports as archived.
 *
 * Archived sessions cannot run model steps, so callers refuse to send or wake
 * them before attempting delivery.
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @returns {string[]}
 */
export function readArchivedIds(ctx) {
  const ids = serviceOf(ctx, 'workspaceRegistry')?.archivedSessionIds
  if (!Array.isArray(ids)) return []
  return ids.filter((id) => typeof id === 'string')
}

/**
 * Read the latest assistant message of a session, truncated for display.
 *
 * The live session snapshot is preferred; `inspect` is the fallback for a
 * session that is not resident in this process. Any read problem degrades to
 * an empty reply rather than failing the wait.
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @param {string} sessionId
 * @returns {Promise<string>}
 */
export async function readLastAssistantText(ctx, sessionId) {
  // Copy before appending: the live snapshot may hand back its own array.
  const events = [...readSnapshotEvents(ctx, sessionId)]
  if (events.length === 0) {
    const controller = serviceOf(ctx, 'sessionController')
    if (controller !== undefined && controller !== null) {
      events.push(...(await inspectEvents(controller, sessionId)))
    }
  }

  const message = [...events].reverse().find((event) => event?.type === 'assistant/message')
  if (message === undefined) return ''
  return truncateText(extractText(message.data?.content), MAX_REPLY_CHARS)
}

/**
 * Clamp a user-supplied timeout into the supported window.
 *
 * Exported so `session_wait` can report the exact budget it waited with; the
 * clamp itself stays a single rule in this module.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function clampTimeout(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_TIMEOUT_MS
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(number)))
}

/**
 * Resolve the agent of a target session through the host controller.
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @param {string} sessionId
 * @returns {Promise<{agent: object, error: null} | {agent: null, error: string}>}
 */
async function resolveAgentFor(ctx, sessionId) {
  const controller = requireController(ctx)

  let resolution
  try {
    resolution = await controller.resolveAgent(sessionId)
  } catch (error) {
    return { agent: null, error: sendFailure(errorMessage(error)) }
  }

  const resolveError = resolution?.error
  if (resolveError !== undefined && resolveError !== null) {
    return { agent: null, error: sendFailure(resolveError.code || 'unknown') }
  }

  const agent = resolution?.agent
  if (agent === undefined || agent === null) return { agent: null, error: sendFailure('unknown') }

  return { agent, error: null }
}

/**
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @param {string} sessionId
 * @returns {object|undefined}
 */
function readAgent(ctx, sessionId) {
  try {
    return serviceOf(ctx, 'agents')?.get?.(sessionId)
  } catch {
    return undefined
  }
}

/**
 * Wait for `agent.whenIdle()` to settle, or for the timeout to win.
 *
 * The timer is cleared as soon as the race settles. It stays referenced while
 * pending on purpose: the wait is the work being performed, so it must keep
 * the event loop alive for its duration. A rejecting `whenIdle` is treated as
 * "did not become idle": the wait is over either way, and reporting a timeout
 * is the least misleading outcome available. An agent without `whenIdle` is
 * considered idle, since there is nothing to wait for.
 *
 * @param {{whenIdle?: () => Promise<unknown>}} agent
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function raceIdle(agent, timeoutMs) {
  if (typeof agent.whenIdle !== 'function') return true

  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  const idle = Promise.resolve()
    .then(() => agent.whenIdle())
    .then(
      () => true,
      () => false,
    )

  try {
    return await Promise.race([idle, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {unknown[]}
 */
function readSnapshotEvents(ctx, sessionId) {
  try {
    const session = serviceOf(ctx, 'sessions')?.get?.(sessionId)
    if (session === undefined || session === null || typeof session.snapshotEvents !== 'function') {
      return []
    }
    const events = session.snapshotEvents()
    return Array.isArray(events) ? events : []
  } catch {
    return []
  }
}

/**
 * @param {object} controller
 * @param {string} sessionId
 * @returns {Promise<unknown[]>}
 */
async function inspectEvents(controller, sessionId) {
  if (typeof controller.inspect !== 'function') return []
  try {
    const inspection = await controller.inspect(sessionId)
    return Array.isArray(inspection?.events) ? inspection.events : []
  } catch {
    return []
  }
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function extractText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * @param {string} detail
 * @returns {string}
 */
function sendFailure(detail) {
  return `session-hub: send failed: ${detail}`
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
