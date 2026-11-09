/**
 * dsh-session-hub — cross-session tools for DeepSeek Harness.
 *
 * Host plugin. Tools are registered incrementally by later commits; this
 * scaffold only declares plugin identity and the required service.
 */
export const name = 'session-hub'

export const inject = ['tools']

/**
 * Mount the plugin.
 * @param {object} ctx - Cordis context provided by the DSH host.
 */
export function apply(ctx) {
  const tools = ctx?.tools
  if (tools === undefined || typeof tools.register !== 'function') return
  ctx.logger?.debug?.('session-hub: plugin mounted')
}
