/**
 * The host method surface session-hub actually calls.
 *
 * Every interface is a deliberate subset: a plugin must not depend on host
 * internals it never uses. All imports are type-only, so the compiled plugin
 * never loads a second copy of a host package.
 */
import type { AgentStatus } from '@deepseek-ai/dsh-agent'
import type { AgentMessage } from '../shared/types.js'

/** The only list query this plugin issues: an unfiltered listing. */
export interface SessionQuery {
  readonly search?: string
}

export interface SessionModelProjection {
  readonly model?: unknown
}

export interface SessionProjectionValues {
  readonly title?: unknown
  readonly modelSelection?: SessionModelProjection
  readonly updatedAt?: unknown
}

export interface SessionProjections {
  readonly values?: SessionProjectionValues
}

export interface SessionSummaryMeta {
  readonly cwd?: unknown
}

/** The identity fields a listing row or session header may carry. */
export interface SessionIdentity {
  readonly sessionId?: unknown
  readonly id?: unknown
}

/** One row of the host session listing. */
export interface SessionSummary extends SessionIdentity {
  readonly sessionId?: unknown
  readonly id?: unknown
  readonly cwd?: unknown
  readonly title?: unknown
  readonly running?: unknown
  readonly blank?: unknown
  readonly status?: unknown
  readonly workspaceId?: unknown
  readonly updatedAt?: unknown
  readonly createdAt?: unknown
  readonly meta?: SessionSummaryMeta
  readonly projections?: SessionProjections
}

export interface SessionListValue {
  readonly items?: unknown
}

export interface SessionCreateRequest {
  workspaceId?: string
  cwd?: string
  agentPreset?: string
}

export interface SessionCreateValue {
  readonly sessionId?: unknown
  readonly agentPreset?: unknown
}

export interface SessionRenameRequest {
  readonly sessionId: string
  readonly title: string
}

export interface SessionSelectModelRequest {
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface ModelCatalogModel {
  readonly id?: unknown
}

export interface ModelCatalogGroup {
  readonly id?: unknown
  readonly models?: readonly ModelCatalogModel[]
}

export interface ModelCatalog {
  readonly groups?: readonly ModelCatalogGroup[]
}

/**
 * The live agent capabilities used by the messaging layer.
 *
 * The host's public `Agent` declares these verbs in terms of its own message
 * type; session-hub builds the message by hand (no host runtime import), so
 * the subset is restated here with the plugin's message shape.
 */
export interface TargetAgent {
  readonly status?: AgentStatus
  inject(message: AgentMessage): Promise<unknown>
  followup(message: AgentMessage): Promise<unknown>
  steer(message: AgentMessage): Promise<unknown>
  whenIdle?(): Promise<unknown>
}

export interface AgentResolutionError {
  readonly code?: unknown
  readonly message?: unknown
}

export interface AgentResolution {
  readonly agent?: TargetAgent
  readonly error?: AgentResolutionError | null
}

export interface SessionController {
  list(query: SessionQuery): Promise<SessionListValue | undefined>
  create(request: SessionCreateRequest): Promise<SessionCreateValue | undefined>
  rename(request: SessionRenameRequest): Promise<unknown>
  selectModel(request: SessionSelectModelRequest): Promise<unknown>
  modelCatalog(): Promise<ModelCatalog | undefined>
  resolveAgent(sessionId: string): Promise<AgentResolution | undefined>
}

export interface WorkspaceSummary {
  readonly id?: unknown
  readonly title?: unknown
  readonly path?: unknown
  readonly sessionIds?: unknown
}

export interface WorkspaceRegistry {
  list(): Promise<readonly WorkspaceSummary[] | undefined>
  readonly archivedSessionIds?: readonly unknown[]
}

export interface ArchiveSessionRequest {
  readonly sessionId: string
  readonly stopActivity: boolean
}

export interface UnarchiveSessionRequest {
  readonly sessionId: string
}

export interface WorkspaceController {
  archiveSession(request: ArchiveSessionRequest): Promise<unknown>
  unarchiveSession(request: UnarchiveSessionRequest): Promise<unknown>
}

/** The live session view: its durable header and event snapshot. */
export interface LiveSession {
  readonly header: Record<string, unknown>
  snapshotEvents(): readonly unknown[]
}

export interface SessionRegistry {
  get?(sessionId: string): LiveSession | undefined
}

export interface AgentRegistry {
  get?(sessionId: string): TargetAgent | undefined
}

/**
 * One ANDed logical-session clause of a cross-session search.
 *
 * The host also accepts `created-at`, `parent` and `availability`; session-hub
 * deliberately only builds `id` and `cwd`, the two clauses its tools expose.
 */
export interface SessionSearchFilter {
  readonly kind: 'id' | 'cwd'
  readonly values: readonly string[]
}

/** Request of `sessionQuery.searchSessions`. */
export interface SessionSearchRequest {
  readonly query: string
  readonly sessionFilters?: readonly SessionSearchFilter[]
  readonly limit?: number
}

/**
 * The header of one search hit.
 *
 * It carries identity, cwd and creation time only — never a title — so a title
 * has to be completed from the session listing.
 */
export interface SessionSearchHeader {
  readonly id?: unknown
  readonly cwd?: unknown
  readonly createdAt?: unknown
}

/** The best event match of one hit; only its snippet is rendered. */
export interface SessionSearchMatch {
  readonly sessionId?: unknown
  readonly snippet?: unknown
}

/** One host search hit: a session plus its best matching event. */
export interface SessionSearchItem {
  readonly header?: SessionSearchHeader
  readonly bestMatch?: SessionSearchMatch
}

/** One page of host search hits. */
export interface SessionSearchResult {
  readonly items?: readonly SessionSearchItem[]
  readonly nextCursor?: unknown
}

/** Execution options accepted by the host search method. */
export interface SessionSearchExec {
  readonly signal?: AbortSignal
}

/** How much projection state one observation computes. */
export type SessionProjectionMode = 'none' | 'all'

/** Options of `sessionQuery.observeSession`. */
export interface SessionObservationOptions {
  readonly signal?: AbortSignal
  readonly projectionMode?: SessionProjectionMode
}

/**
 * One borrowed read cut of a session log.
 *
 * The host pins a cold observation until it is disposed, so a caller copies the
 * header and events and then releases the lease in the same turn.
 */
export interface SessionObservation {
  readonly header: Record<string, unknown>
  readonly events: readonly unknown[]
  readonly [Symbol.dispose]?: () => void
}

/** The host session-query capabilities session-hub calls. */
export interface SessionQueryService {
  searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExec,
  ): Promise<SessionSearchResult | undefined>
  observeSession?(
    sessionId: string,
    options?: SessionObservationOptions,
  ): Promise<SessionObservation>
}
