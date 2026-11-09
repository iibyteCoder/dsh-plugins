/**
 * Accessors for the host services session-hub depends on.
 *
 * These services are provided by the DSH host. They are optional in the
 * sense that another profile may not expose them, so callers must decide
 * how to degrade; this module performs no existence validation on read.
 */

/**
 * Collect the host services used by the tools.
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @returns {{controller: object|undefined, workspaceController: object|undefined, workspaces: object|undefined, sessions: object|undefined, agents: object|undefined}}
 */
export function readServices(ctx) {
  return {
    controller: ctx?.sessionController,
    workspaceController: ctx?.workspaceController,
    workspaces: ctx?.workspaceRegistry,
    sessions: ctx?.sessions,
    agents: ctx?.agents,
  }
}

/**
 * Return the session controller, or throw a plugin-prefixed error when the
 * current profile does not provide it.
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @returns {object}
 */
export function requireController(ctx) {
  const { controller } = readServices(ctx)
  if (controller === undefined || controller === null) {
    throw new Error('session-hub: sessionController service is unavailable in this profile')
  }
  return controller
}

/**
 * Return the workspace controller, or throw a plugin-prefixed error when the
 * current profile does not provide it. It owns session archiving and
 * unarchiving.
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @returns {object}
 */
export function requireWorkspaceController(ctx) {
  const { workspaceController } = readServices(ctx)
  if (workspaceController === undefined || workspaceController === null) {
    throw new Error('session-hub: workspaceController service is unavailable in this profile')
  }
  return workspaceController
}
