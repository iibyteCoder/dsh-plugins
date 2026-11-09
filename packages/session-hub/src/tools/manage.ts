/**
 * Mutating session tools: `session_update`, `session_close`, `session_open`.
 *
 * Authorization is enforced here against the plugin's owner index, before any
 * host change is attempted. The tools never throw: every failure is rendered
 * as `session-hub: ...` text so a misbehaving call cannot take down the agent.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { resolveModelSelection } from '../domain/model-selection.js'
import { confirmError, confirmRequired, ownerOf } from '../domain/ownership.js'
import { renderClosed, renderModelSelection, renderOpened, renderText, renderUpdated } from '../format/renders.js'
import { requireController, requireWorkspaceController } from '../host/services.js'
import { asToolArgs, stringArg } from '../shared/args.js'
import { ErrorCode, PermissionMode, ToolName } from '../shared/enums.js'
import { errorMessage, sessionHubError, sessionHubText, toErrorText } from '../shared/errors.js'
import type {
  HostContext,
  ModelChangeView,
  TitleChangeView,
  ToolArgs,
  ToolExecContext,
  ToolOptions,
  UpdatedSessionView,
} from '../shared/types.js'

const SESSION_UPDATE_DESCRIPTION =
  'Update an existing DeepSeek Harness session: rename it and/or select its model.'

const SESSION_UPDATE_DESCRIPTION_OWNED = [
  SESSION_UPDATE_DESCRIPTION,
  'Updating a session the caller did not create requires confirm: true.',
].join(' ')

const SESSION_CLOSE_DESCRIPTION = [
  'Close a DeepSeek Harness session by archiving it and stopping its activity.',
  'Restore it later with session_open. The calling session cannot close itself.',
].join(' ')

const SESSION_CLOSE_DESCRIPTION_OWNED = [
  'Close a DeepSeek Harness session by archiving it and stopping its activity.',
  'Restore it later with session_open. The calling session cannot close itself.',
  'Closing a session the caller did not create requires confirm: true.',
].join(' ')

const SESSION_OPEN_DESCRIPTION = [
  'Restore a previously closed (archived) DeepSeek Harness session. It is idempotent and needs no confirmation.',
].join(' ')

/** Build the mutating session tools bound to a host context. */
export function createManageTools(
  ctx: HostContext,
  options: ToolOptions = { permissionMode: PermissionMode.Permissive },
): ToolDefinition[] {
  return [
    createSessionUpdateTool(ctx, options.permissionMode),
    createSessionCloseTool(ctx, options.permissionMode),
    createSessionOpenTool(ctx),
  ]
}

function createSessionUpdateTool(ctx: HostContext, permissionMode: PermissionMode): ToolDefinition {
  const owned = permissionMode === PermissionMode.Owned
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
  if (owned) {
    properties.confirm = {
      type: 'boolean',
      description: 'Must be true to update a session the caller did not create.',
    }
  }

  return {
    name: ToolName.SessionUpdate,
    description: owned ? SESSION_UPDATE_DESCRIPTION_OWNED : SESSION_UPDATE_DESCRIPTION,
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
        return await executeSessionUpdate(ctx, rawArgs, exec, permissionMode)
      } catch (error) {
        return toErrorText(error)
      }
    },
  } satisfies ToolDefinition
}

function createSessionCloseTool(ctx: HostContext, permissionMode: PermissionMode): ToolDefinition {
  const owned = permissionMode === PermissionMode.Owned
  const properties: Record<string, unknown> = {
    session_id: {
      type: 'string',
      description: 'Session id to close.',
    },
  }
  if (owned) {
    properties.confirm = {
      type: 'boolean',
      description: 'Must be true to close a session the caller did not create.',
    }
  }

  return {
    name: ToolName.SessionClose,
    description: owned ? SESSION_CLOSE_DESCRIPTION_OWNED : SESSION_CLOSE_DESCRIPTION,
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
        return await executeSessionClose(ctx, rawArgs, exec, permissionMode)
      } catch (error) {
        return toErrorText(error)
      }
    },
  } satisfies ToolDefinition
}

function createSessionOpenTool(ctx: HostContext): ToolDefinition {
  return {
    name: ToolName.SessionOpen,
    description: SESSION_OPEN_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session id to restore from the archive.',
        },
      },
      required: ['session_id'],
    },
    output: {
      schema: { type: 'string' },
      render: renderText,
    },
    async execute(rawArgs) {
      try {
        return await executeSessionOpen(ctx, rawArgs)
      } catch (error) {
        return toErrorText(error)
      }
    },
  } satisfies ToolDefinition
}

async function executeSessionUpdate(
  ctx: HostContext,
  rawArgs: unknown,
  exec: ToolExecContext,
  permissionMode: PermissionMode,
): Promise<string> {
  const args = asToolArgs(rawArgs)
  const controller = requireController(ctx)

  const sessionId = stringArg(args, 'session_id')
  if (sessionId === '') return sessionHubText('session_id is required')

  const denial = await ownedDenial(sessionId, args, permissionMode, callerIdOf(exec))
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
  permissionMode: PermissionMode,
): Promise<string> {
  const args = asToolArgs(rawArgs)
  const sessionId = stringArg(args, 'session_id')
  if (sessionId === '') return sessionHubText('session_id is required')

  const callerId = callerIdOf(exec)
  // Self-close is refused outright in both modes, before any confirmation
  // check: owned mode's `confirm: true` is not an escape hatch for it.
  if (callerId !== '' && sessionId === callerId) {
    return sessionHubError(ErrorCode.SelfCloseForbidden, 'a session cannot close itself')
  }

  const denial = await ownedDenial(sessionId, args, permissionMode, callerId)
  if (denial !== null) return denial

  const workspaceController = requireWorkspaceController(ctx)
  try {
    await workspaceController.archiveSession({ sessionId, stopActivity: true })
  } catch (error) {
    return sessionHubText(`close failed: ${errorMessage(error)}`)
  }

  return renderClosed(sessionId)
}

async function executeSessionOpen(ctx: HostContext, rawArgs: unknown): Promise<string> {
  const args = asToolArgs(rawArgs)
  const sessionId = stringArg(args, 'session_id')
  if (sessionId === '') return sessionHubText('session_id is required')

  const workspaceController = requireWorkspaceController(ctx)
  try {
    await workspaceController.unarchiveSession({ sessionId })
  } catch (error) {
    return sessionHubText(`open failed: ${errorMessage(error)}`)
  }

  return renderOpened(sessionId)
}

/**
 * Enforce owned-mode authorization.
 *
 * `confirm` only counts when it is the boolean true; "true", 1 and the like
 * must not be accepted as authorization.
 */
async function ownedDenial(
  sessionId: string,
  args: ToolArgs,
  permissionMode: PermissionMode,
  callerId: string,
): Promise<string | null> {
  if (permissionMode !== PermissionMode.Owned) return null
  const ownerId = await ownerOf(sessionId)
  if (confirmRequired(ownerId, callerId) && args.confirm !== true) {
    return confirmError(sessionId)
  }
  return null
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
