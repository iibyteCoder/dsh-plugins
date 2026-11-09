/**
 * Read-only accessors for the host services session-hub depends on.
 *
 * These services are provided by the DSH host. They are optional in the
 * sense that another profile may not expose them, so callers must decide
 * how to degrade; this module performs no existence validation on read.
 */

/**
 * Collect the host services used by the read tools.
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @returns {{controller: object|undefined, workspaces: object|undefined, sessions: object|undefined, agents: object|undefined}}
 */
export function readServices(ctx) {
  return {
    controller: ctx?.sessionController,
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
