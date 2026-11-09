/**
 * `session_create`: create a session, record ownership, then apply the
 * optional title/model/task in that order.
 *
 * The session exists after `create` returns, so every later step reports its
 * own failure on its own line instead of turning the create into a failure.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { resolveModelSelection } from '../domain/model-selection.js'
import { wake } from '../domain/messaging.js'
import { renderCreated, renderText } from '../format/renders.js'
import { recordOwner } from '../host/owner-index.js'
import { findWorkspace, normalizeCwd } from '../host/session-access.js'
import { requireController } from '../host/services.js'
import type { SessionCreateRequest, SessionCreateValue, WorkspaceSummary } from '../host/contracts.js'
import { asToolArgs, stringArg, textOrDash } from '../shared/args.js'
import { ToolName } from '../shared/enums.js'
import { errorMessage, sessionHubText, toErrorText } from '../shared/errors.js'
import type {
  CreatedSessionView,
  DeliveryResult,
  HostContext,
  ModelChangeView,
  TitleChangeView,
  ToolArgs,
  ToolExecContext,
  ToolOptions,
} from '../shared/types.js'

const SESSION_CREATE_DESCRIPTION = [
  'Create a new DeepSeek Harness session, optionally inside a workspace or at a specific cwd, and record the calling session as its owner.',
  'The required message is delivered to the new session as its initial task, which starts it immediately.',
  'Returns the new session id.',
].join(' ')

/** Build the `session_create` tool bound to a host context. */
export function createSessionCreateTool(
  ctx: HostContext,
  _options?: ToolOptions,
): ToolDefinition {
  return {
    name: ToolName.SessionCreate,
    description: SESSION_CREATE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: 'Workspace id, title, or path. Mutually exclusive with cwd.',
        },
        cwd: {
          type: 'string',
          description: 'Directory for the new session. Mutually exclusive with workspace.',
        },
        title: {
          type: 'string',
          description: 'Title to apply right after the session is created.',
        },
        agent_preset: {
          type: 'string',
          description: 'Agent preset passed to the host create request.',
        },
        model: {
          type: 'string',
          description: 'Model id to select after creation. Resolved against the model catalog when provider is omitted.',
        },
        provider: {
          type: 'string',
          description: 'Provider id for model. Requires model.',
        },
        reasoning_effort: {
          type: 'string',
          description: 'Reasoning effort for the selected model. Requires model.',
        },
        message: {
          type: 'string',
          description: 'Initial task delivered to the new session; it starts the session immediately.',
        },
      },
      required: ['message'],
    },
    output: {
      schema: { type: 'string' },
      render: renderText,
    },
    async execute(rawArgs, exec) {
      try {
        return await executeSessionCreate(ctx, rawArgs, exec)
      } catch (error) {
        return toErrorText(error)
      }
    },
  } satisfies ToolDefinition
}

async function executeSessionCreate(
  ctx: HostContext,
  rawArgs: unknown,
  exec: ToolExecContext,
): Promise<string> {
  const args = asToolArgs(rawArgs)
  const controller = requireController(ctx)

  const message = stringArg(args, 'message')
  if (message === '') return sessionHubText('message is required')

  const workspaceArg = stringArg(args, 'workspace')
  const cwdArg = stringArg(args, 'cwd')
  if (workspaceArg !== '' && cwdArg !== '') {
    return sessionHubText('workspace and cwd are mutually exclusive')
  }

  // `workspaceId` and `cwd` are mutually exclusive at the host boundary too,
  // so only one of them can ever be set here.
  const request: SessionCreateRequest = {}
  let workspace: WorkspaceSummary | null = null
  if (workspaceArg !== '') {
    workspace = await findWorkspace(ctx, workspaceArg)
    if (workspace === null) return sessionHubText(`workspace "${workspaceArg}" not found`)
    request.workspaceId = typeof workspace.id === 'string' ? workspace.id : ''
  } else if (cwdArg !== '') {
    request.cwd = normalizeCwd(cwdArg)
  } else {
    const callerCwd = normalizeCwd(callerCwdOf(exec))
    if (callerCwd !== '') request.cwd = callerCwd
  }

  const title = stringArg(args, 'title')
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
  const owner = await recordOwnership(sessionId, callerId)

  let titleChange: TitleChangeView | undefined
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
  if (hasModelRequest(args)) {
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
  const started = await deliverInitialTask(ctx, sessionId, message, callerId)

  const view: CreatedSessionView = {
    sessionId,
    workspace: textOrDash(workspace?.title),
    cwd: request.cwd ?? '-',
    agentPreset: presetLabel(created, agentPreset),
    owner,
    started,
    ...(titleChange === undefined ? {} : { title: titleChange }),
    ...(modelChange === undefined ? {} : { model: modelChange }),
  }
  return renderCreated(view)
}

/**
 * Deliver the initial task to the freshly created session.
 *
 * Wake semantics are used (`followup` on the idle new session) so the session
 * starts working immediately instead of waiting for a later turn.
 */
async function deliverInitialTask(
  ctx: HostContext,
  sessionId: string,
  message: string,
  callerId: string,
): Promise<string> {
  let result: DeliveryResult
  try {
    result = await wake(ctx, { sessionId, text: message, senderId: callerId })
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

function callerIdOf(exec: ToolExecContext): string {
  return typeof exec.agent?.id === 'string' ? exec.agent.id.trim() : ''
}

function callerCwdOf(exec: ToolExecContext): unknown {
  return exec.agent?.session?.header?.cwd
}

function nonEmptyStringOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
