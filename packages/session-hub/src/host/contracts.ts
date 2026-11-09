/**
 * The host method surface session-hub actually calls.
 *
 * Every interface is a deliberate subset: a plugin must not depend on host
 * internals it never uses. All imports are type-only, so the compiled plugin
 * never loads a second copy of a host package.
 */
import type { AgentStatus } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
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

/** The identity fields a listing row or inspection metadata may carry. */
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

export interface SessionInspectionMeta extends SessionIdentity {
  readonly createdAt?: unknown
  readonly created_at?: unknown
  readonly cwd?: unknown
  readonly parentSession?: unknown
  readonly parentSessionId?: unknown
  readonly origin?: unknown
  readonly agentPreset?: unknown
  readonly agentPresetId?: unknown
}

/** Result of `sessionController.inspect`. */
export interface SessionInspection {
  readonly meta?: SessionInspectionMeta
  readonly createdAt?: unknown
  readonly cwd?: unknown
  readonly parentSession?: unknown
  readonly origin?: unknown
  readonly agentPreset?: unknown
  readonly events?: unknown
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
  inspect(sessionId: string, signal?: AbortSignal): Promise<SessionInspection | null | undefined>
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

/** The live session view: only the event snapshot is read. */
export type SessionSnapshot = Pick<Session, 'snapshotEvents'>

export interface SessionRegistry {
  get?(sessionId: string): SessionSnapshot | undefined
}

export interface AgentRegistry {
  get?(sessionId: string): TargetAgent | undefined
}
