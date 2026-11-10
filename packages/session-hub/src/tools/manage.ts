/**
 * Mutating session tools: `session_update`, `session_close`, `session_open`.
 *
 * Authorization is enforced here against the plugin's owner index, before any
 * host change is attempted. Each tool reads its own resolved policy for
 * `targets`, `confirm` and (where it applies) `allowSelf`. The tools never
 * throw: every failure is rendered as `session-hub: ...` text so a misbehaving
 * call cannot take down the agent.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { ResolvedSettings, ResolvedToolPolicy } from '../config/resolve.js'
import { authorizeTarget } from '../domain/authorization.js'
import { resolveModelSelection } from '../domain/model-selection.js'
import {
  renderClosed,
  renderModelSelection,
  renderOpened,
  renderText,
  renderUpdated,
} from '../format/renders.js'
import { requireController, requireWorkspaceController } from '../host/services.js'
import { asToolArgs, stringArg } from '../shared/args.js'
import { ErrorCode, ToolName } from '../shared/enums.js'
import { errorMessage, sessionHubError, sessionHubText, toErrorText } from '../shared/errors.js'
import { callerIdOf } from '../shared/exec.js'
import type {
  HostContext,
  ModelChangeView,
  TitleChangeView,
  ToolArgs,
  ToolExecContext,
  UpdatedSessionView,
} from '../shared/types.js'

const SESSION_UPDATE_DESCRIPTION =
  'Update an existing DeepSeek Harness session: rename it and/or select its model.'

const SESSION_CLOSE_DESCRIPTION = [
  'Close a DeepSeek Harness session by archiving it and stopping its activity.',
  'Restore it later with session_open.',
].join(' ')

const SESSION_OPEN_DESCRIPTION = [
  'Restore a previously closed (archived) DeepSeek Harness session. It is idempotent.',
].join(' ')

/** Build the mutating session tools bound to a host context and config. */
export function createManageTools(ctx: HostContext, settings: ResolvedSettings): ToolDefinition[] {
  return [
    createSessionUpdateTool(ctx, settings.tools[ToolName.SessionUpdate]),
    createSessionCloseTool(ctx, settings.tools[ToolName.SessionClose]),
    createSessionOpenTool(ctx, settings.tools[ToolName.SessionOpen]),
  ]
}

function createSessionUpdateTool(ctx: HostContext, policy: ResolvedToolPolicy): ToolDefinition {
  const properties: Record<string, unknown> = {
    session_id: {
      type: 'string',
      description: 'Session id to update.',
    },
    title: {
      type: 'string',
      description: 'New session title.',
    },
    model: {
      type: 'string',
      description: 'Model id to select. Resolved against the model catalog when provider is omitted.',
    },
    provider: {
      type: 'string',
      description: 'Provider id for model. Requires model.',
    },
    reasoning_effort: {
      type: 'string',
      description: 'Reasoning effort for the selected model. Requires model.',
    },
  }
  addConfirmProperty(properties, policy.confirm, 'update')

  return {
    name: ToolName.SessionUpdate,
    description: withConfirmHint(SESSION_UPDATE_DESCRIPTION, policy.confirm),
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
        return await executeSessionUpdate(ctx, rawArgs, exec, policy)
      } catch (error) {
        return toErrorText(error)
      }
    },
  } satisfies ToolDefinition
}

function createSessionCloseTool(ctx: HostContext, policy: ResolvedToolPolicy): ToolDefinition {
  const properties: Record<string, unknown> = {
    session_id: {
      type: 'string',
      description: 'Session id to close.',
    },
  }
  addConfirmProperty(properties, policy.confirm, 'close')

  return {
    name: ToolName.SessionClose,
    description: withConfirmHint(SESSION_CLOSE_DESCRIPTION, policy.confirm),
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
        return await executeSessionClose(ctx, rawArgs, exec, policy)
      } catch (error) {
        return toErrorText(error)
      }
    },
  } satisfies ToolDefinition
}

function createSessionOpenTool(ctx: HostContext, policy: ResolvedToolPolicy): ToolDefinition {
  const properties: Record<string, unknown> = {
    session_id: {
      type: 'string',
      description: 'Session id to restore from the archive.',
    },
  }
  addConfirmProperty(properties, policy.confirm, 'open')

  return {
    name: ToolName.SessionOpen,
    description: withConfirmHint(SESSION_OPEN_DESCRIPTION, policy.confirm),
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
        return await executeSessionOpen(ctx, rawArgs, exec, policy)
      } catch (error) {
        return toErrorText(error)
      }
    },
  } satisfies ToolDefinition
}

/** `confirm` only exists in the schema when it can actually be required. */
function addConfirmProperty(
  properties: Record<string, unknown>,
  confirm: ResolvedToolPolicy['confirm'],
  verb: string,
): void {
  if (confirm === 'never') return
  properties.confirm = {
    type: 'boolean',
    description:
      confirm === 'always'
        ? `Must be true to ${verb} any session.`
        : `Must be true to ${verb} a session the caller did not create.`,
  }
}

function withConfirmHint(base: string, confirm: ResolvedToolPolicy['confirm']): string {
  switch (confirm) {
    case 'never':
      return base
    case 'non-owned':
      return `${base} Acting on a session the caller did not create requires confirm: true.`
    case 'always':
      return `${base} Every call requires confirm: true.`
  }
}

async function executeSessionUpdate(
  ctx: HostContext,
  rawArgs: unknown,
  exec: ToolExecContext,
  policy: ResolvedToolPolicy,
): Promise<string> {
  const args = asToolArgs(rawArgs)
  const controller = requireController(ctx)

  const sessionId = stringArg(args, 'session_id')
  if (sessionId === '') return sessionHubText('session_id is required')

  const denial = await authorize(sessionId, args, exec, policy, 'update')
  if (denial !== null) return denial

  const title = stringArg(args, 'title')
  const wantsModel = hasModelRequest(args)
  if (title === '' && !wantsModel) return sessionHubText('nothing to update')

  // Resolve the model before applying anything: a resolution failure must not
  // leave a half-applied update behind. Resolution performs no side effects.
  const resolution = wantsModel ? await resolveModelSelection(controller, args) : null
  const modelError = resolution !== null && 'error' in resolution ? resolution.error : null

  // A model-only request with an unresolvable model has no successful change
  // to report, so surface the resolution error verbatim.
  if (title === '' && modelError !== null) return modelError

  let titleChange: TitleChangeView | undefined
  if (title !== '') {
    try {
      await controller.rename({ sessionId, title })
      titleChange = { value: title }
    } catch (error) {
      titleChange = { error: errorMessage(error) }
    }
  }

  let modelChange: ModelChangeView | undefined
  if (wantsModel) {
    if (resolution !== null && 'selection' in resolution) {
      const selection = resolution.selection
      try {
        await controller.selectModel({ sessionId, ...selection })
        modelChange = { value: renderModelSelection(selection) }
      } catch (error) {
        modelChange = { error: errorMessage(error) }
      }
    } else if (modelError !== null) {
      // The title (if any) was already applied above; report both outcomes so
      // the caller does not read a partial update as a total failure.
      modelChange = { error: modelError }
    }
  }

  const view: UpdatedSessionView = {
    sessionId,
    ...(titleChange === undefined ? {} : { title: titleChange }),
    ...(modelChange === undefined ? {} : { model: modelChange }),
  }
  return renderUpdated(view)
}

async function executeSessionClose(
  ctx: HostContext,
  rawArgs: unknown,
  exec: ToolExecContext,
  policy: ResolvedToolPolicy,
): Promise<string> {
  const args = asToolArgs(rawArgs)
  const sessionId = stringArg(args, 'session_id')
  if (sessionId === '') return sessionHubText('session_id is required')

  // Self-close is decided by `allowSelf` (false by default) before any
  // confirmation check: `confirm: true` is not an escape hatch for it.
  const denial = await authorize(sessionId, args, exec, policy, 'close')
  if (denial !== null) return denial

  const workspaceController = requireWorkspaceController(ctx)
  try {
    await workspaceController.archiveSession({ sessionId, stopActivity: true })
  } catch (error) {
    return sessionHubText(`close failed: ${errorMessage(error)}`)
  }

  return renderClosed(sessionId)
}

async function executeSessionOpen(
  ctx: HostContext,
  rawArgs: unknown,
  exec: ToolExecContext,
  policy: ResolvedToolPolicy,
): Promise<string> {
  const args = asToolArgs(rawArgs)
  const sessionId = stringArg(args, 'session_id')
  if (sessionId === '') return sessionHubText('session_id is required')

  // Opening is harmless and `allowSelf` is not part of its documented policy.
  const denial = await authorize(sessionId, args, exec, policy, 'open')
  if (denial !== null) return denial

  const workspaceController = requireWorkspaceController(ctx)
  try {
    await workspaceController.unarchiveSession({ sessionId })
  } catch (error) {
    return sessionHubText(`open failed: ${errorMessage(error)}`)
  }

  return renderOpened(sessionId)
}

/** Run the shared target authorization; `null` means "allowed". */
async function authorize(
  sessionId: string,
  args: ToolArgs,
  exec: ToolExecContext,
  policy: ResolvedToolPolicy,
  verb: 'update' | 'close' | 'open',
): Promise<string | null> {
  const allowSelf = verb === 'open' ? true : policy.allowSelf
  const result = await authorizeTarget({
    sessionId,
    callerId: callerIdOf(exec),
    targets: policy.targets,
    confirm: policy.confirm,
    allowSelf,
    confirmGiven: args.confirm,
    selfError:
      verb === 'close'
        ? sessionHubError(ErrorCode.SelfCloseForbidden, 'a session cannot close itself')
        : sessionHubError(ErrorCode.SelfTarget, `a session cannot ${verb} itself`),
  })
  return 'error' in result ? result.error : null
}

/** True when any model-selection argument carries a value. */
function hasModelRequest(args: ToolArgs): boolean {
  return (
    stringArg(args, 'model') !== '' ||
    stringArg(args, 'provider') !== '' ||
    stringArg(args, 'reasoning_effort') !== ''
  )
}
