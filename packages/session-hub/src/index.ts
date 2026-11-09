/**
 * dsh-session-hub — cross-session tools for DeepSeek Harness.
 *
 * Host plugin entry point. `apply` resolves the permission mode once, then
 * registers the ten tools; every tool factory receives the same options so
 * the registration surface is fixed for this plugin instance.
 */
import type { Context } from '@deepseek-ai/cordis'

import { resolvePermissionMode } from './config.js'
import { createTools } from './tools/registry.js'
import type { ToolOptions } from './shared/types.js'

export const name = 'session-hub'

export const inject = ['tools']

/**
 * Mount the plugin.
 *
 * @param ctx - Cordis context provided by the DSH host.
 * @param config - Plugin config (`permissionMode` is the only field read).
 */
export function apply(ctx: Context, config?: unknown): void {
  const tools = ctx?.tools
  if (tools === undefined || typeof tools.register !== 'function') return

  const options: ToolOptions = { permissionMode: resolvePermissionMode(config) }
  for (const tool of createTools(ctx, options)) {
    tools.register(tool)
  }
}
