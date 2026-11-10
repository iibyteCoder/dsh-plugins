/**
 * dsh-session-hub — cross-session tools for DeepSeek Harness.
 *
 * Host plugin entry point. `apply` validates the profile config once through
 * the exported `Config` schema, resolves it into per-tool policies, then
 * registers only the enabled tools; every tool factory receives the same
 * resolved settings so the registration surface is fixed for this plugin
 * instance.
 */
import type { Context } from '@deepseek-ai/cordis'

import { resolveSettings } from './config/resolve.js'
import { createTools } from './tools/registry.js'

export { Config } from './config/schema.js'

export const name = 'session-hub'

export const inject = ['tools']

/**
 * Mount the plugin.
 *
 * @param ctx - Cordis context provided by the DSH host.
 * @param config - Raw plugin config; `Config` supplies every default and any
 * invalid value falls back to its per-tool default instead of throwing.
 */
export function apply(ctx: Context, config?: unknown): void {
  const tools = ctx?.tools
  if (tools === undefined || typeof tools.register !== 'function') return

  const settings = resolveSettings(config)
  for (const tool of createTools(ctx, settings)) {
    tools.register(tool)
  }
}
