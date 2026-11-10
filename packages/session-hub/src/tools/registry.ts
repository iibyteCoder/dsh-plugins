/**
 * Tool registry: the single place that fixes the registration order of the ten
 * session-hub tools and drops the ones disabled by the profile config.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { ResolvedSettings } from '../config/resolve.js'
import type { HostContext } from '../shared/types.js'
import { ToolName } from '../shared/enums.js'
import { createSessionCreateTool } from './create.js'
import { createManageTools } from './manage.js'
import { createReadTools } from './read.js'
import { createSearchTool } from './search.js'
import { createSendTools } from './send.js'

/**
 * Build every enabled tool bound to one host context and one resolved config.
 *
 * `enabled: false` means "do not register": the tool is absent from the model's
 * tool table instead of failing at call time.
 */
export function createTools(ctx: HostContext, settings: ResolvedSettings): ToolDefinition[] {
  const tools = [
    ...createReadTools(ctx, settings),
    createSessionCreateTool(ctx, settings),
    ...createManageTools(ctx, settings),
    ...createSendTools(ctx, settings),
    createSearchTool(ctx, settings),
  ]
  return tools.filter((tool) => settings.tools[tool.name as ToolName].enabled)
}
