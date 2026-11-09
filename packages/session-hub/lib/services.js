/**
 * Accessors for the host services session-hub depends on.
 *
 * These services are provided by the DSH host. They are optional in the
 * sense that another profile may not expose them, so callers must decide
 * how to degrade; this module performs no existence validation on read.
 *
 * A Cordis context is a proxy: reading a service that the plugin did not
 * declare in `inject` throws `cannot get property "..." without inject`.
 * `ctx.get(name)` is the documented safe entry point and is the only way
 * this plugin touches host services. `tools` is declared in `inject`, so
 * `lib/index.js` may read that one directly.
 */

/**
 * Read one host service without the inject requirement.
 *
 * Both the access (`ctx.get`) and the call are guarded: a context without
 * `get` (tests, another host, a plain object) and a throwing `get` both
 * degrade to "service unavailable" instead of failing the tool call.
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @param {string} name - Service name, e.g. `'sessionController'`.
 * @returns {object|undefined} The service, or `undefined` when not provided.
 */
export function serviceOf(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/**
 * Collect the host services used by the tools.
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @returns {{controller: object|undefined, workspaceController: object|undefined, workspaces: object|undefined, sessions: object|undefined, agents: object|undefined}}
 */
export function readServices(ctx) {
  return {
    controller: serviceOf(ctx, 'sessionController'),
    workspaceController: serviceOf(ctx, 'workspaceController'),
    workspaces: serviceOf(ctx, 'workspaceRegistry'),
    sessions: serviceOf(ctx, 'sessions'),
    agents: serviceOf(ctx, 'agents'),
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
  const controller = serviceOf(ctx, 'sessionController')
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
  const workspaceController = serviceOf(ctx, 'workspaceController')
  if (workspaceController === undefined || workspaceController === null) {
    throw new Error('session-hub: workspaceController service is unavailable in this profile')
  }
  return workspaceController
}
