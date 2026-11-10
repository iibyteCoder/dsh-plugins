/**
 * `session_create`: create a session, optionally record ownership, then apply
 * the optional title/model/task in that order.
 *
 * The session exists after `create` returns, so every later step reports its
 * own failure on its own line instead of turning the create into a failure.
 * The configured policy decides whether excluding a title/model parameter from
 * the schema also disables the corresponding step.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { ResolvedSettings, ResolvedToolPolicy, WorkspacePolicy } from '../config/resolve.js'
import { isCwdAllowed, matchesAllowList } from '../domain/visibility.js'
import { resolveModelSelection } from '../domain/model-selection.js'
import { wake } from '../domain/messaging.js'
import { renderCreated, renderText } from '../format/renders.js'
import { recordOwner } from '../host/owner-index.js'
import { findWorkspace, cwdKey, loadWorkspaces, normalizeCwd } from '../host/session-access.js'
import { readServices, requireController } from '../host/services.js'
import type { SessionCreateRequest, SessionCreateValue, WorkspaceSummary } from '../host/contracts.js'
import { asToolArgs, stringArg, textOrDash } from '../shared/args.js'
import { ToolName } from '../shared/enums.js'
import { errorMessage, sessionHubText, toErrorText } from '../shared/errors.js'
import { callerCwdOf, callerIdOf } from '../shared/exec.js'
import type {
  CreatedSessionView,
  DeliveryResult,
  HostContext,
  ModelChangeView,
  TitleChangeView,
  ToolArgs,
  ToolExecContext,
} from '../shared/types.js'

const SESSION_CREATE_DESCRIPTION = [
  'Create a new DeepSeek Harness session, optionally inside a workspace or at a specific cwd, and record the calling session as its owner.',
  'The initial task is delivered to the new session and starts it immediately.',
  'Returns the new session id.',
].join(' ')

const NOT_RECORDED = '未记录（ownership.record 已关闭）'

/** Where `session_create` will put the new session, after policy resolution. */
interface CreateTarget {
  readonly kind: 'workspace' | 'cwd' | 'default'
  readonly workspace?: WorkspaceSummary
  readonly cwd: string
  readonly description: string
}

/** Build the `session_create` tool bound to a host context and config. */
export function createSessionCreateTool(
  ctx: HostContext,
  settings: ResolvedSettings,
): ToolDefinition {
  const policy = settings.tools[ToolName.SessionCreate]
  const properties = createProperties(policy)
  const description =
    policy.task === 'optional'
      ? `${SESSION_CREATE_DESCRIPTION} The initial task is optional; when omitted the session is not started.`
      : SESSION_CREATE_DESCRIPTION

  return {
    name: ToolName.SessionCreate,
    description,
    parameters: {
      type: 'object',
      properties,
      required: policy.task === 'required' ? ['message'] : [],
    },
    output: {
      schema: { type: 'string' },
      render: renderText,
    },
    async execute(rawArgs, exec) {
      try {
        return await executeSessionCreate(ctx, settings, policy, rawArgs, exec)
      } catch (error) {
        return toErrorText(error)
      }
    },
  } satisfies ToolDefinition
}

/** The parameter set allowed by `allowTitle` / `allowModel`. */
function createProperties(policy: ResolvedToolPolicy): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    workspace: {
      type: 'string',
      description: 'Workspace id, title, or path. Mutually exclusive with cwd.',
    },
    cwd: {
      type: 'string',
      description: 'Directory for the new session. Mutually exclusive with workspace.',
    },
    agent_preset: {
      type: 'string',
      description: 'Agent preset passed to the host create request.',
    },
    message: {
      type: 'string',
      description: policy.task === 'required'
        ? 'Initial task delivered to the new session; it starts the session immediately.'
        : 'Optional initial task; when present it starts the new session immediately.',
    },
  }

  if (policy.allowTitle) {
    properties.title = {
      type: 'string',
      description: 'Title to apply right after the session is created.',
    }
  }

  if (policy.allowModel) {
    properties.model = {
      type: 'string',
      description: 'Model id to select after creation. Resolved against the model catalog when provider is omitted.',
    }
    properties.provider = {
      type: 'string',
      description: 'Provider id for model. Requires model.',
    }
    properties.reasoning_effort = {
      type: 'string',
      description: 'Reasoning effort for the selected model. Requires model.',
    }
  }

  return properties
}

async function executeSessionCreate(
  ctx: HostContext,
  settings: ResolvedSettings,
  policy: ResolvedToolPolicy,
  rawArgs: unknown,
  exec: ToolExecContext,
): Promise<string> {
  const args = asToolArgs(rawArgs)
  const controller = requireController(ctx)

  const message = stringArg(args, 'message')
  if (policy.task === 'required' && message === '') {
    return sessionHubText('message is required')
  }

  const workspaceArg = stringArg(args, 'workspace')
  const cwdArg = stringArg(args, 'cwd')
  if (workspaceArg !== '' && cwdArg !== '') {
    return sessionHubText('workspace and cwd are mutually exclusive')
  }

  const callerCwd = normalizeCwd(callerCwdOf(exec))
  const target = await resolveTarget(ctx, workspaceArg, cwdArg, callerCwd)
  if ('error' in target) return target.error

  const policyError = await checkWorkspacePolicy(ctx, policy.workspace, settings, target, callerCwd)
  if (policyError !== null) return policyError

  const request: SessionCreateRequest = {}
  if (target.kind === 'workspace') {
    request.workspaceId = typeof target.workspace?.id === 'string' ? target.workspace.id : ''
  } else if (target.cwd !== '') {
    request.cwd = target.cwd
  }

  const agentPreset = stringArg(args, 'agent_preset')
  if (agentPreset !== '') request.agentPreset = agentPreset

  let created: SessionCreateValue | undefined
  try {
    created = await controller.create(request)
  } catch (error) {
    return sessionHubText(`create failed: ${errorMessage(error)}`)
  }

  const sessionId = nonEmptyStringOf(created?.sessionId)
  if (sessionId === '') return sessionHubText('create failed: host returned no session id')

  const callerId = callerIdOf(exec)
  const owner = settings.ownership.record
    ? await recordOwnership(sessionId, callerId)
    : NOT_RECORDED

  let titleChange: TitleChangeView | undefined
  const title = policy.allowTitle ? stringArg(args, 'title') : ''
  if (title !== '') {
    try {
      await controller.rename({ sessionId, title })
      titleChange = { value: title }
    } catch (error) {
      titleChange = { error: errorMessage(error) }
    }
  }

  // The session is already created at this point: a model problem must be
  // reported, never turn the create result into a failure.
  let modelChange: ModelChangeView | undefined
  if (policy.allowModel && hasModelRequest(args)) {
    const resolution = await resolveModelSelection(controller, args)
    if (resolution !== null && 'error' in resolution) {
      modelChange = { error: resolution.error }
    } else if (resolution !== null) {
      const selection = resolution.selection
      try {
        await controller.selectModel({ sessionId, ...selection })
        modelChange = { value: `${selection.provider}/${selection.model}` }
      } catch (error) {
        modelChange = { error: errorMessage(error) }
      }
    }
  }

  // The initial task is delivered after rename/model selection so the first
  // turn already sees the intended title and model.
  const started =
    message === '' ? '未提供初始任务（未唤醒）' : await deliverInitialTask(ctx, policy, sessionId, message, callerId)

  const view: CreatedSessionView = {
    sessionId,
    workspace: textOrDash(target.workspace?.title),
    cwd: target.kind === 'workspace' ? '-' : target.cwd === '' ? '-' : target.cwd,
    agentPreset: presetLabel(created, agentPreset),
    owner,
    started,
    ...(titleChange === undefined ? {} : { title: titleChange }),
    ...(modelChange === undefined ? {} : { model: modelChange }),
  }
  return renderCreated(view)
}

/** Resolve the requested target, or report the existing validation errors. */
async function resolveTarget(
  ctx: HostContext,
  workspaceArg: string,
  cwdArg: string,
  callerCwd: string,
): Promise<CreateTarget | { readonly error: string }> {
  if (workspaceArg !== '') {
    const workspace = await findWorkspace(ctx, workspaceArg)
    if (workspace === null) {
      return { error: sessionHubText(`workspace "${workspaceArg}" not found`) }
    }
    return {
      kind: 'workspace',
      workspace,
      cwd: typeof workspace.path === 'string' ? normalizeCwd(workspace.path) : '',
      description: `workspace "${workspaceArg}"`,
    }
  }

  if (cwdArg !== '') {
    const cwd = normalizeCwd(cwdArg)
    return { kind: 'cwd', cwd, description: `cwd "${cwd}"` }
  }

  return {
    kind: 'default',
    cwd: callerCwd,
    description: callerCwd === '' ? 'the caller cwd' : `the caller cwd "${callerCwd}"`,
  }
}

/**
 * Enforce the configured `workspace` policy.
 *
 * `same` requires the target cwd to equal the caller cwd, including the
 * default target. `allowlist` requires the target (workspace, explicit cwd, or
 * the inherited caller cwd) to live inside a workspace named by
 * `filters.allowWorkspaces`.
 */
async function checkWorkspacePolicy(
  ctx: HostContext,
  policy: WorkspacePolicy,
  settings: ResolvedSettings,
  target: CreateTarget,
  callerCwd: string,
): Promise<string | null> {
  if (policy === 'any') return null

  if (policy === 'same') {
    if (cwdKey(callerCwd) === '') {
      return sessionHubText('workspace policy "same" requires a caller cwd')
    }
    if (target.cwd === '' || cwdKey(target.cwd) !== cwdKey(callerCwd)) {
      return sessionHubText(`workspace policy "same" only allows ${targetDescriptionOfCallerCwd(callerCwd)}`)
    }
    return null
  }

  // allowlist
  if (settings.filters.allowWorkspaces.length === 0) {
    return sessionHubText('workspace policy "allowlist" has no allowed workspaces configured')
  }

  if (target.kind === 'workspace') {
    const workspace = target.workspace
    if (workspace !== undefined && matchesAllowList(workspace, settings.filters.allowWorkspaces)) {
      return null
    }
    return sessionHubText(`workspace policy "allowlist" does not allow ${target.description}`)
  }

  const workspaces = await loadWorkspaces(readServices(ctx).workspaces)
  if (isCwdAllowed(target.cwd, settings.filters.allowWorkspaces, workspaces)) return null
  return sessionHubText(`workspace policy "allowlist" does not allow ${target.description}`)
}

function targetDescriptionOfCallerCwd(callerCwd: string): string {
  return callerCwd === '' ? 'the caller cwd' : `the caller cwd "${callerCwd}"`
}

/**
 * Deliver the initial task to the freshly created session.
 *
 * Wake semantics are used (`followup` on the idle new session) so the session
 * starts working immediately instead of waiting for a later turn.
 */
async function deliverInitialTask(
  ctx: HostContext,
  policy: ResolvedToolPolicy,
  sessionId: string,
  message: string,
  callerId: string,
): Promise<string> {
  let result: DeliveryResult
  try {
    result = await wake(ctx, {
      sessionId,
      text: message,
      senderId: callerId,
      attribution: policy.attribution,
      whenRunning: policy.whenRunning,
    })
  } catch (error) {
    result = { ok: false, text: sessionHubText(`send failed: ${errorMessage(error)}`) }
  }
  return result.ok ? '已投递初始任务' : `失败（${result.text}）`
}

/**
 * Persist the caller → new session relationship.
 *
 * A missing caller id is not an error: the session was still created, so the
 * result only says ownership is unknown.
 */
async function recordOwnership(sessionId: string, callerId: string): Promise<string> {
  if (callerId === '') return '未知（调用方会话 id 不可用）'
  try {
    await recordOwner(sessionId, callerId)
    return 'self'
  } catch (error) {
    return `记录失败（${errorMessage(error)}）`
  }
}

function presetLabel(created: SessionCreateValue | undefined, requested: string): string {
  const resolved = created?.agentPreset
  if (typeof resolved === 'string' && resolved !== '') return resolved
  return requested === '' ? '-' : requested
}

/** True when any model-selection argument carries a value. */
function hasModelRequest(args: ToolArgs): boolean {
  return (
    stringArg(args, 'model') !== '' ||
    stringArg(args, 'provider') !== '' ||
    stringArg(args, 'reasoning_effort') !== ''
  )
}

function nonEmptyStringOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
