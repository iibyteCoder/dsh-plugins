/**
 * `session_search`: full-text search across indexed sessions.
 *
 * Read-only: it has no `confirm` in either permission mode. The mode only
 * narrows which sessions the host index is asked about, and that scoping is
 * owned by `domain/search.ts`.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { searchSessions } from '../domain/search.js'
import { renderSearchResults, renderText } from '../format/renders.js'
import { asToolArgs, integerOption, stringArg } from '../shared/args.js'
import { PermissionMode, ToolName } from '../shared/enums.js'
import { sessionHubText, toErrorText } from '../shared/errors.js'
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MIN_LIMIT,
} from '../shared/limits.js'
import type { HostContext, ToolExecContext, ToolOptions } from '../shared/types.js'

const SESSION_SEARCH_DESCRIPTION = [
  'Search the text of every indexed DeepSeek Harness session and return the best match per session.',
  'Each row shows the session id, its title and the matching snippet.',
  'Use it to find a session by remembered content, then call session_get for its details.',
].join(' ')

const SESSION_SEARCH_DESCRIPTION_OWNED = [
  SESSION_SEARCH_DESCRIPTION,
  'Owned mode restricts results to the calling session and the sessions it created.',
].join(' ')

/** Build the `session_search` tool bound to a host context. */
export function createSearchTool(
  ctx: HostContext,
  options: ToolOptions = { permissionMode: PermissionMode.Permissive },
): ToolDefinition {
  const owned = options.permissionMode === PermissionMode.Owned
  return {
    name: ToolName.SessionSearch,
    description: owned ? SESSION_SEARCH_DESCRIPTION_OWNED : SESSION_SEARCH_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to search for across session events.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of hits to return (default 20, max 50).',
          default: SEARCH_DEFAULT_LIMIT,
        },
        cwd: {
          type: 'string',
          description: 'Exact session cwd to restrict the search to.',
        },
      },
      required: ['query'],
    },
    output: {
      schema: { type: 'string' },
      render: renderText,
    },
    async execute(rawArgs, exec) {
      try {
        return await executeSessionSearch(ctx, options, rawArgs, exec)
      } catch (error) {
        return toErrorText(error)
      }
    },
  } satisfies ToolDefinition
}

async function executeSessionSearch(
  ctx: HostContext,
  options: ToolOptions,
  rawArgs: unknown,
  exec: ToolExecContext,
): Promise<string> {
  const args = asToolArgs(rawArgs)
  const query = stringArg(args, 'query')
  if (query === '') return sessionHubText('query is required')

  const view = await searchSessions(
    ctx,
    {
      query,
      limit: integerOption(args.limit, SEARCH_DEFAULT_LIMIT, SEARCH_MIN_LIMIT, SEARCH_MAX_LIMIT),
      cwd: stringArg(args, 'cwd'),
      permissionMode: options.permissionMode,
      callerId: callerIdOf(exec),
    },
    exec.signal,
  )
  return renderSearchResults(view)
}

function callerIdOf(exec: ToolExecContext): string {
  return typeof exec.agent?.id === 'string' ? exec.agent.id.trim() : ''
}
