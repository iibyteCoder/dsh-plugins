/**
 * Data models shared by every layer.
 *
 * Host payloads cross the plugin boundary as `unknown` and are narrowed by the
 * accessors in `host/`; the interfaces here describe only the plugin's own
 * contracts (views, results, options) so no layer leaks an anonymous shape.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { WhenRunningPolicy } from '../config/resolve.js'
import type { MessageKind, SessionEventKind, SessionStatus, WaitOutcome } from './enums.js'

/** The single host capability `apply` requires through `inject`. */
export interface ToolRegistrar {
  register(tool: ToolDefinition): unknown
}

/**
 * The parts of a Cordis context the plugin touches.
 *
 * `tools` is declared in `inject` and may be read as a property; every other
 * service must go through `get`. Both stay optional so a plain test object
 * degrades to "service unavailable" instead of throwing.
 */
export interface HostContext {
  readonly get?: (name: string) => unknown
  readonly tools?: ToolRegistrar
}

/** Session metadata exposed on the calling agent at tool execution time. */
export interface ToolExecSession {
  readonly header?: ToolExecHeader
}

export interface ToolExecHeader {
  readonly cwd?: unknown
}

/** The calling agent, as far as the tools read it. */
export interface ToolExecAgent {
  readonly id?: string
  readonly session?: ToolExecSession
}

/** The tool execution context fields the plugin consumes. */
export interface ToolExecContext {
  readonly agent?: ToolExecAgent
  readonly signal?: AbortSignal
}

/** Arguments arrive as decoded JSON; every field is narrowed on read. */
export type ToolArgs = Readonly<Record<string, unknown>>

/** One persisted ownership record. */
export interface OwnerRecord {
  readonly ownerSessionId: string
  readonly createdAt?: number | string
  readonly [extra: string]: unknown
}

/** The ownership index keyed by the created session id. */
export interface OwnerIndex {
  readonly [sessionId: string]: OwnerRecord
}

/** A resolved model selection. */
export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Raw model-selection arguments from a tool call. */
export interface ModelSelectionArgs {
  readonly provider?: unknown
  readonly model?: unknown
  readonly reasoning_effort?: unknown
}

export interface ModelSelectionSuccess {
  readonly selection: ModelSelection
}

export interface ModelSelectionFailure {
  readonly error: string
}

export type ModelSelectionOutcome = ModelSelectionSuccess | ModelSelectionFailure | null

/** Options of `deliver`/`wake`. */
export interface DeliveryOptions {
  readonly sessionId: string
  readonly text: string
  readonly senderId?: string
  /** Whether the body carries the `Agent <id> sent a message:` prefix. */
  readonly attribution?: boolean
  /** How a running target is woken; idle targets always get a follow-up. */
  readonly whenRunning?: WhenRunningPolicy
}

/** Result of a delivery attempt; failures are text, never exceptions. */
export interface DeliveryResult {
  readonly ok: boolean
  readonly text: string
}

/** Result of `waitForIdle`. */
export interface WaitResult {
  readonly status: WaitOutcome
  readonly reply: string
}

/** A text block of the host user-message shape. */
export interface AgentTextBlock {
  readonly type: 'text'
  readonly text: string
}

/**
 * The relay source of a cross-session message.
 *
 * `form: 'relay'` is the host wire literal; keeping it a literal type documents
 * the protocol without inventing a domain enum.
 */
export interface AgentMessageSource {
  readonly kind: MessageKind.AgentMessage
  readonly form: 'relay'
  readonly senderSessionId?: string
}

/** A hand-built host user message attributed to the sending session. */
export interface AgentMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly AgentTextBlock[]
  readonly source: AgentMessageSource
}

/** A session event as the read paths consume it. */
export interface SessionEventView {
  readonly type?: string
  readonly data?: SessionEventData
}

export interface SessionEventData {
  readonly content?: unknown
  readonly source?: SessionEventSource
  /** The assistant message wrapper: `assistant/message` stores its content here. */
  readonly message?: SessionEventMessage
}

export interface SessionEventMessage {
  readonly content?: unknown
}

export interface SessionEventSource {
  readonly kind?: unknown
}

/** One row of `session_list`. */
export interface SessionView {
  readonly id: string
  readonly title: string
  readonly workspace: string
  readonly cwd: string
  readonly status: SessionStatus
  readonly model: string
  readonly owner: string
  readonly updatedAt: unknown
}

/** One recent message rendered by `session_get`. */
export interface SessionMessageView {
  readonly type: SessionEventKind
  readonly kind: string
  readonly text: string
}

/** Everything `session_get` renders. */
export interface SessionDetail {
  readonly id: string
  readonly createdAt: unknown
  readonly cwd: unknown
  readonly parentSession: unknown
  readonly origin: unknown
  readonly agentPreset: unknown
  readonly status: SessionStatus
  readonly owner: string
  readonly recentMessages: readonly SessionMessageView[]
}

/** Input of the list renderer. */
export interface SessionListView {
  readonly rows: readonly SessionView[]
  readonly total: number
}

/** One deduplicated session hit of `session_search`. */
export interface SearchHit {
  readonly sessionId: string
  readonly title: string
  readonly snippet: string
}

/**
 * Result of `session_search`, and the input of its renderer.
 *
 * `total` counts the raw hits returned by the host, before hits are collapsed
 * per session; `hits` holds one row per matching session.
 */
export interface SearchView {
  readonly hits: readonly SearchHit[]
  readonly total: number
  readonly hasMore: boolean
}

/** A workspace title matched by the `session_list` workspace filter. */
export interface WorkspaceFilter {
  readonly needle: string
  readonly matched: readonly WorkspaceMatch[]
}

/** A workspace as far as the filter needs to identify it. */
export interface WorkspaceMatch {
  readonly id?: unknown
  readonly title?: unknown
  readonly path?: unknown
}

/** One optional title outcome of `session_update` / `session_create`. */
export interface TitleChangeView {
  readonly value?: string
  readonly error?: string
}

/** One optional model outcome of `session_update` / `session_create`. */
export interface ModelChangeView {
  readonly value?: string
  readonly error?: string
}

/** Input of the `session_create` renderer. */
export interface CreatedSessionView {
  readonly sessionId: string
  readonly workspace: string
  readonly cwd: string
  readonly agentPreset: string
  readonly owner: string
  readonly title?: TitleChangeView
  readonly model?: ModelChangeView
  readonly started: string
}

/** Input of the `session_update` renderer. */
export interface UpdatedSessionView {
  readonly sessionId: string
  readonly title?: TitleChangeView
  readonly model?: ModelChangeView
}

/** Successful authorization of a send/wake target. */
export interface AuthorizedTarget {
  readonly sessionId: string
  readonly callerId: string
}

/** Rejected send/wake target, already rendered as outward text. */
export interface AuthorizationFailure {
  readonly error: string
}

export type AuthorizationResult = AuthorizedTarget | AuthorizationFailure
