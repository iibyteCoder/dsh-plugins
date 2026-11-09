/**
 * Tool registry: the single place that fixes the registration order of the
 * ten session-hub tools.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { HostContext, ToolOptions } from '../shared/types.js'
import { createSessionCreateTool } from './create.js'
import { createManageTools } from './manage.js'
import { createReadTools } from './read.js'
import { createSearchTool } from './search.js'
import { createSendTools } from './send.js'

/** Build every tool bound to one host context and permission mode. */
export function createTools(ctx: HostContext, options: ToolOptions): ToolDefinition[] {
  return [
    ...createReadTools(ctx, options),
    createSessionCreateTool(ctx, options),
    ...createManageTools(ctx, options),
    ...createSendTools(ctx, options),
    createSearchTool(ctx, options),
  ]
}
