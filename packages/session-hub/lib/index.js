/**
 * dsh-session-hub — cross-session tools for DeepSeek Harness.
 *
 * Host plugin. Tools are registered incrementally; this version exposes the
 * read-only `session_list` / `session_get` tools, lifecycle tools
 * (`session_create`, `session_update`, `session_close`, `session_open`) and
 * communication tools (`session_send`, `session_interrupt`).
 */
import { createSessionCreateTool } from './tools/create.js'
import { createManageTools } from './tools/manage.js'
import { createReadTools } from './tools/read.js'
import { createSendTools } from './tools/send.js'

export const name = 'session-hub'

export const inject = ['tools']

/**
 * Mount the plugin.
 * @param {object} ctx - Cordis context provided by the DSH host.
 */
export function apply(ctx) {
  const tools = ctx?.tools
  if (tools === undefined || typeof tools.register !== 'function') return
  for (const tool of [
    ...createReadTools(ctx),
    createSessionCreateTool(ctx),
    ...createManageTools(ctx),
    ...createSendTools(ctx),
  ]) {
    tools.register(tool)
  }
}
