/**
 * Closed vocabularies used across the plugin.
 *
 * Every domain concept that has a finite, stable set of values is a string
 * enum here, so a tool, a renderer and a test can only ever compare against
 * the same spelling.
 */

/** Which authorization surface the mutating tools expose. */
export enum PermissionMode {
  Permissive = 'permissive',
  Owned = 'owned',
}

/** The public tool names registered with the host. */
export enum ToolName {
  SessionList = 'session_list',
  SessionGet = 'session_get',
  SessionCreate = 'session_create',
  SessionUpdate = 'session_update',
  SessionClose = 'session_close',
  SessionOpen = 'session_open',
  SessionSend = 'session_send',
  SessionWake = 'session_wake',
  SessionWait = 'session_wait',
  SessionSearch = 'session_search',
}

/**
 * Stable error codes rendered as `session-hub: <CODE>: <detail>`.
 *
 * Only failures that already carried a machine-readable code before the
 * TypeScript migration are listed; plain validation messages keep their
 * original text and are rendered through `sessionHubText`.
 */
export enum ErrorCode {
  ConfirmRequired = 'CONFIRM_REQUIRED',
  SelfCloseForbidden = 'SELF_CLOSE_FORBIDDEN',
  SelfTarget = 'SELF_TARGET',
  SessionArchived = 'SESSION_ARCHIVED',
  WaitTimeout = 'WAIT_TIMEOUT',
  SearchUnavailable = 'SEARCH_UNAVAILABLE',
  SearchFailed = 'SEARCH_FAILED',
}

/** Lifecycle status of one session, as session-hub reports it. */
export enum SessionStatus {
  Running = 'running',
  Idle = 'idle',
  Blank = 'blank',
  Archived = 'archived',
  Unknown = 'unknown',
}

/** Values accepted by the `session_list` status filter (`all` means no filter). */
export enum StatusFilter {
  All = 'all',
  Running = 'running',
  Idle = 'idle',
  Blank = 'blank',
  Archived = 'archived',
}

/** Outcome of `session_wait`, distinguishing the four terminal states. */
export enum WaitOutcome {
  Archived = 'archived',
  Cold = 'cold',
  Timeout = 'timeout',
  Idle = 'idle',
}

/** The `source.kind` carried by a relayed agent message. */
export enum MessageKind {
  AgentMessage = 'agent-message',
}

/**
 * How a woken session receives a message.
 *
 * `Queue` keeps the host's wire/display verb `followup`: the message is
 * queued and starts a turn on an idle target.
 */
export enum DeliveryMode {
  Queue = 'followup',
  Steer = 'steer',
}

/** Host event types that carry a conversation message. */
export enum SessionEventKind {
  UserMessage = 'user/message',
  AssistantMessage = 'assistant/message',
}

/** Host services read through `ctx.get`. */
export enum HostService {
  SessionController = 'sessionController',
  WorkspaceController = 'workspaceController',
  WorkspaceRegistry = 'workspaceRegistry',
  Sessions = 'sessions',
  Agents = 'agents',
  SessionQuery = 'sessionQuery',
}

/** The `owner` filter sentinel values of `session_list`; any other value is a session id. */
export enum OwnerFilter {
  Any = 'any',
  Self = 'self',
}
