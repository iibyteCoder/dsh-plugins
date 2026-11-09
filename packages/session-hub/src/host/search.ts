/**
 * Typed access to the host `sessionQuery` service.
 *
 * The service is mounted by the host's session-query plugin; session-hub only
 * consumes it through `ctx.get`, so a profile without that plugin degrades to a
 * coded error instead of a stack trace. Both conversions — "service missing"
 * and "search failed" — live here, so the tool layer only passes the text on.
 */
import { ErrorCode, HostService } from '../shared/enums.js'
import { errorMessage, sessionHubError } from '../shared/errors.js'
import type { HostContext } from '../shared/types.js'
import type {
  SessionQueryService,
  SessionSearchRequest,
  SessionSearchResult,
} from './contracts.js'
import { serviceOf } from './services.js'

/** The `SEARCH_UNAVAILABLE` failure of a profile without the search service. */
function searchUnavailableError(): Error {
  return new Error(
    sessionHubError(
      ErrorCode.SearchUnavailable,
      `${HostService.SessionQuery} service is unavailable in this profile`,
    ),
  )
}

/**
 * Resolve the host search service, or throw `SEARCH_UNAVAILABLE`.
 *
 * Keeping resolution separate from the call lets the domain check the
 * capability before it spends work on permission scoping: a profile without the
 * search index must report the missing service even when the caller's scope
 * would be empty.
 */
export function requireSessionQuery(ctx: HostContext): SessionQueryService {
  const service = serviceOf(ctx, HostService.SessionQuery) as
    | SessionQueryService
    | null
    | undefined
  if (service === undefined || service === null || typeof service.searchSessions !== 'function') {
    throw searchUnavailableError()
  }
  return service
}

/**
 * Run one cross-session search.
 *
 * Every backend failure becomes `SEARCH_FAILED` carrying the original message;
 * a missing page is normalized to "no hits".
 */
export async function executeSessionSearch(
  service: SessionQueryService,
  request: SessionSearchRequest,
  signal: AbortSignal | undefined,
): Promise<SessionSearchResult> {
  let result: SessionSearchResult | undefined
  try {
    result = await service.searchSessions(request, signal === undefined ? undefined : { signal })
  } catch (error) {
    throw new Error(sessionHubError(ErrorCode.SearchFailed, errorMessage(error)))
  }
  return result ?? {}
}
