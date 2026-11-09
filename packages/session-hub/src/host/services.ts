/**
 * Accessors for the host services session-hub depends on.
 *
 * A Cordis context is a proxy: reading a service the plugin did not declare in
 * `inject` throws `cannot get property "..." without inject`. `ctx.get(name)`
 * is the documented safe entry point and is the only way this plugin touches
 * host services; `tools` is declared in `inject` and is the one property read
 * directly (in `index.ts`).
 *
 * A profile may not provide every service, so accessors return `undefined` and
 * `require*` throws a plugin-prefixed error for callers that cannot degrade.
 */
import { HostService } from '../shared/enums.js'
import { sessionHubText } from '../shared/errors.js'
import type { HostContext } from '../shared/types.js'
import type {
  AgentRegistry,
  SessionController,
  SessionRegistry,
  WorkspaceController,
  WorkspaceRegistry,
} from './contracts.js'

/** The host services used by the tools, each possibly absent. */
export interface HostServices {
  readonly controller: SessionController | undefined
  readonly workspaceController: WorkspaceController | undefined
  readonly workspaces: WorkspaceRegistry | undefined
  readonly sessions: SessionRegistry | undefined
  readonly agents: AgentRegistry | undefined
}

/**
 * Read one host service without the inject requirement.
 *
 * Both the access (`ctx.get`) and the call are guarded: a context without
 * `get` (tests, another host, a plain object) and a throwing `get` both
 * degrade to "service unavailable" instead of failing the tool call.
 */
export function serviceOf(ctx: HostContext, name: HostService): unknown {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/** Collect the host services used by the tools. */
export function readServices(ctx: HostContext): HostServices {
  return {
    controller: serviceOf(ctx, HostService.SessionController) as SessionController | undefined,
    workspaceController: serviceOf(ctx, HostService.WorkspaceController) as
      | WorkspaceController
      | undefined,
    workspaces: serviceOf(ctx, HostService.WorkspaceRegistry) as WorkspaceRegistry | undefined,
    sessions: serviceOf(ctx, HostService.Sessions) as SessionRegistry | undefined,
    agents: serviceOf(ctx, HostService.Agents) as AgentRegistry | undefined,
  }
}

/** Return the session controller, or throw when the profile does not provide it. */
export function requireController(ctx: HostContext): SessionController {
  const controller = serviceOf(ctx, HostService.SessionController) as SessionController | null | undefined
  if (controller === undefined || controller === null) {
    throw new Error(
      sessionHubText(`${HostService.SessionController} service is unavailable in this profile`),
    )
  }
  return controller
}

/**
 * Return the workspace controller, or throw when the profile does not provide
 * it. It owns session archiving and unarchiving.
 */
export function requireWorkspaceController(ctx: HostContext): WorkspaceController {
  const workspaceController = serviceOf(ctx, HostService.WorkspaceController) as
    | WorkspaceController
    | null
    | undefined
  if (workspaceController === undefined || workspaceController === null) {
    throw new Error(
      sessionHubText(`${HostService.WorkspaceController} service is unavailable in this profile`),
    )
  }
  return workspaceController
}
