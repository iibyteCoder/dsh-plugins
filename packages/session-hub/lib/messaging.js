/**
 * Cross-session message delivery.
 *
 * `session_send` and `session_create`'s `initial_message` both deliver a
 * message to another session, so message shape, delivery mode, wait semantics
 * and timeout handling live here once. The host contract is deliberately
 * small: resolve the target agent, hand it a user message through
 * `followup`/`steer`, and optionally wait for it to become idle.
 *
 * No `@deepseek-ai/*` module is imported: the user message is built by hand
 * with the host's shape so the plugin never shadows the host's own copy.
 */
import { randomUUID } from 'node:crypto'

import { truncateText } from './format.js'
import { requireController } from './services.js'

const DEFAULT_TIMEOUT_MS = 120000
const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 600000
const MAX_REPLY_CHARS = 2000
const WAIT_TIMEOUT_TEXT =
  'session-hub: WAIT_TIMEOUT: message delivered but the session did not become idle'

/**
 * Deliver `text` to another session as an agent-relayed user message.
 *
 * Delivery failure is reported as text, like the rest of the mutating tools;
 * only a missing host service throws (the tool wrapper renders that as text
 * too).
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @param {{sessionId: string, text: string, mode?: 'queue'|'steer', wait?: boolean, timeoutMs?: number, senderId?: string}} options
 * @returns {Promise<{ok: boolean, text: string}>}
 */
export async function sendToSession(
  ctx,
  { sessionId, text, mode = 'queue', wait = false, timeoutMs = DEFAULT_TIMEOUT_MS, senderId = '' } = {},
) {
  const controller = requireController(ctx)

  let resolution
  try {
    resolution = await controller.resolveAgent(sessionId)
  } catch (error) {
    return sendFailure(errorMessage(error))
  }

  const resolveError = resolution?.error
  if (resolveError !== undefined && resolveError !== null) {
    return sendFailure(resolveError.code || 'unknown')
  }

  const agent = resolution?.agent
  if (agent === undefined || agent === null) return sendFailure('unknown')

  const message = buildUserMessage(text, senderId)
  try {
    if (mode === 'steer') {
      await agent.steer(message)
    } else {
      await agent.followup(message)
    }
  } catch (error) {
    return sendFailure(errorMessage(error))
  }

  const delivered = `已向会话 ${sessionId} 发送消息（mode=${mode === 'steer' ? 'steer' : 'queue'}）`

  if (wait !== true || typeof agent.whenIdle !== 'function') {
    return { ok: true, text: delivered }
  }

  const becameIdle = await waitForIdle(agent, clampTimeout(timeoutMs))
  if (!becameIdle) return { ok: false, text: WAIT_TIMEOUT_TEXT }

  const reply = await readLatestReply(ctx, controller, sessionId)
  return { ok: true, text: reply === '' ? delivered : `${delivered}\n- reply: ${reply}` }
}

/**
 * The session ids the workspace registry currently reports as archived.
 *
 * Archived sessions cannot run model steps, so callers refuse to send to them
 * before attempting delivery.
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @returns {string[]}
 */
export function readArchivedIds(ctx) {
  const ids = ctx?.workspaceRegistry?.archivedSessionIds
  if (!Array.isArray(ids)) return []
  return ids.filter((id) => typeof id === 'string')
}

/**
 * Build the host user-message shape, attributed to the sending session.
 *
 * A known sender is announced in the body and carried in `source`; an unknown
 * sender (missing caller id) produces the same kind of message without an
 * identity claim.
 *
 * @param {unknown} text
 * @param {string} senderId
 * @returns {{id: string, role: 'user', content: {type: 'text', text: string}[], source: {kind: string, form: string, senderSessionId?: string}}}
 */
function buildUserMessage(text, senderId) {
  const sender = typeof senderId === 'string' ? senderId.trim() : ''
  const body = typeof text === 'string' ? text : String(text ?? '')
  const content = [{ type: 'text', text: sender === '' ? body : `Agent ${sender} sent a message:\n\n${body}` }]

  const source = { kind: 'agent-message', form: 'relay' }
  if (sender !== '') source.senderSessionId = sender

  return { id: randomUUID(), role: 'user', content, source }
}

/**
 * Wait for `agent.whenIdle()` to settle, or for the timeout to win.
 *
 * The timer is cleared as soon as the race settles. It stays referenced while
 * pending on purpose: the wait is the work being performed, so it must keep
 * the event loop alive for its duration. A rejecting `whenIdle` is treated as
 * "did not become idle": the message was already delivered, so reporting the
 * failure as WAIT_TIMEOUT is the least misleading outcome available.
 *
 * @param {{whenIdle: () => Promise<unknown>}} agent
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForIdle(agent, timeoutMs) {
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
 * Read the latest assistant message of the target session.
 *
 * The live session snapshot is preferred; `inspect` is the fallback for a
 * session that is not resident in this process. Any read problem degrades to
 * an empty reply rather than failing the already-delivered send.
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @param {object} controller - Host session controller.
 * @param {string} sessionId
 * @returns {Promise<string>}
 */
async function readLatestReply(ctx, controller, sessionId) {
  // Copy before appending: the live snapshot may hand back its own array.
  const events = [...readSnapshotEvents(ctx, sessionId)]
  if (events.length === 0) {
    const inspected = await inspectEvents(controller, sessionId)
    events.push(...inspected)
  }

  const message = [...events].reverse().find((event) => event?.type === 'assistant/message')
  if (message === undefined) return ''
  return truncateText(extractText(message.data?.content), MAX_REPLY_CHARS)
}

/**
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {unknown[]}
 */
function readSnapshotEvents(ctx, sessionId) {
  try {
    const session = ctx?.sessions?.get?.(sessionId)
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
 * Clamp a user-supplied timeout into the supported window.
 *
 * @param {unknown} value
 * @returns {number}
 */
function clampTimeout(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_TIMEOUT_MS
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(number)))
}

/**
 * @param {string} detail
 * @returns {{ok: false, text: string}}
 */
function sendFailure(detail) {
  return { ok: false, text: `session-hub: send failed: ${detail}` }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
