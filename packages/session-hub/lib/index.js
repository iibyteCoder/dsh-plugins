/**
 * dsh-session-hub — cross-session tools for DeepSeek Harness.
 *
 * Host plugin. Tools are registered incrementally; this version exposes the
 * read-only `session_list` / `session_get` tools and the writing `session_create`
 * tool.
 */
import { createSessionCreateTool } from './tools/create.js'
import { createReadTools } from './tools/read.js'

export const name = 'session-hub'

export const inject = ['tools']

/**
 * Mount the plugin.
 * @param {object} ctx - Cordis context provided by the DSH host.
 */
export function apply(ctx) {
  const tools = ctx?.tools
  if (tools === undefined || typeof tools.register !== 'function') return
  for (const tool of [...createReadTools(ctx), createSessionCreateTool(ctx)]) {
    tools.register(tool)
  }
  ctx.logger?.debug?.('session-hub: plugin mounted')
}
