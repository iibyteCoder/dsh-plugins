/**
 * dsh-session-hub — cross-session tools for DeepSeek Harness.
 *
 * Host plugin. Tools are registered incrementally; this version exposes the
 * read-only `session_list` / `session_get` tools, lifecycle tools
 * (`session_create`, `session_update`, `session_close`, `session_open`) and
 * communication tools (`session_send`, `session_interrupt`).
 */
import { resolvePermissionMode } from './config.js'
import { createSessionCreateTool } from './tools/create.js'
import { createManageTools } from './tools/manage.js'
import { createReadTools } from './tools/read.js'
import { createSendTools } from './tools/send.js'

export const name = 'session-hub'

export const inject = ['tools']

/**
 * Mount the plugin.
 *
 * The permission mode is resolved once here and passed to every tool factory,
 * so the registration surface (for example whether `confirm` exists at all) is
 * fixed for this plugin instance.
 *
 * @param {object} ctx - Cordis context provided by the DSH host.
 * @param {{permissionMode?: unknown}} [config] - Plugin config.
 */
export function apply(ctx, config) {
  const tools = ctx?.tools
  if (tools === undefined || typeof tools.register !== 'function') return

  const options = { permissionMode: resolvePermissionMode(config) }
  for (const tool of [
    ...createReadTools(ctx, options),
    createSessionCreateTool(ctx, options),
    ...createManageTools(ctx, options),
    ...createSendTools(ctx, options),
  ]) {
    tools.register(tool)
  }
}
