/**
 * `session_search`: full-text search across indexed sessions.
 *
 * Read-only: it never asks for confirmation. The configured `scope` and
 * filters only narrow which sessions the host index is asked about, and that
 * scoping is owned by `domain/search.ts`.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { ResolvedSettings, ResolvedToolPolicy } from '../config/resolve.js'
import { searchSessions } from '../domain/search.js'
import { renderSearchResults, renderText } from '../format/renders.js'
import { asToolArgs, integerOption, stringArg } from '../shared/args.js'
import { ToolName } from '../shared/enums.js'
import { sessionHubText, toErrorText } from '../shared/errors.js'
import { callerCwdOf, callerIdOf } from '../shared/exec.js'
import { SEARCH_MAX_LIMIT, SEARCH_MIN_LIMIT } from '../shared/limits.js'
import type { HostContext, ToolExecContext } from '../shared/types.js'
import { cwdKey } from '../host/session-access.js'

const SESSION_SEARCH_DESCRIPTION = [
  'Search the text of every indexed DeepSeek Harness session and return the best match per session.',
  'Each row shows the session id, its title and the matching snippet.',
  'Use it to find a session by remembered content, then call session_get for its details.',
].join(' ')

const SCOPED_DESCRIPTIONS: Readonly<Record<ResolvedToolPolicy['scope'], string>> = {
  all: '',
  workspace: 'Only sessions whose cwd matches the calling session are searched.',
  owned: 'Only sessions created by the calling session are searched.',
}

/** Build the `session_search` tool bound to a host context and config. */
export function createSearchTool(ctx: HostContext, settings: ResolvedSettings): ToolDefinition {
  const policy = settings.tools[ToolName.SessionSearch]
  const scoped = SCOPED_DESCRIPTIONS[policy.scope]
  return {
    name: ToolName.SessionSearch,
    description: scoped === '' ? SESSION_SEARCH_DESCRIPTION : `${SESSION_SEARCH_DESCRIPTION} ${scoped}`,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to search for across session events.',
        },
        limit: {
          type: 'integer',
          description: `Maximum number of hits to return (default ${policy.limit}, max ${SEARCH_MAX_LIMIT}).`,
          default: policy.limit,
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
        return await executeSessionSearch(ctx, settings, policy, rawArgs, exec)
      } catch (error) {
        return toErrorText(error)
      }
    },
  } satisfies ToolDefinition
}

async function executeSessionSearch(
  ctx: HostContext,
  settings: ResolvedSettings,
  policy: ResolvedToolPolicy,
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
      limit: integerOption(args.limit, policy.limit, SEARCH_MIN_LIMIT, SEARCH_MAX_LIMIT),
      cwd: stringArg(args, 'cwd'),
      scope: policy.scope,
      callerId: callerIdOf(exec),
      callerCwdKey: cwdKey(callerCwdOf(exec)),
      filters: settings.filters,
    },
    exec.signal,
  )
  return renderSearchResults(view)
}
