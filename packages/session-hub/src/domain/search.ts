/**
 * `session_search` scoping and result shaping.
 *
 * The read policy changes which sessions the host index is asked about, so the
 * allowed id set is resolved here, before the search runs: a policy can never
 * return a session the caller is not allowed to see.
 *
 * The host answers one hit per matching event, so the same session may repeat;
 * hits are collapsed per session (first match wins) and their titles are
 * completed from the session listing.
 */
import { readOwnerIndex } from '../host/owner-index.js'
import { executeSessionSearch, requireSessionQuery } from '../host/search.js'
import {
  listSessionItems,
  loadWorkspaces,
  readSessionTitles,
  sessionCwd,
  sessionIdOf,
  workspaceForSession,
} from '../host/session-access.js'
import { readServices, serviceOf } from '../host/services.js'
import type { SessionSearchFilter, SessionSearchItem, SessionSearchRequest, SessionSummary } from '../host/contracts.js'
import { hasAnyFilter, isSessionVisible, type VisibilityRules } from './visibility.js'
import { HostService } from '../shared/enums.js'
import type { SessionController } from '../host/contracts.js'
import type { HostContext, SearchHit, SearchView } from '../shared/types.js'

/** One validated `session_search` call. */
export interface SearchOptions extends VisibilityRules {
  readonly query: string
  readonly limit: number
  /** Exact cwd to restrict the search to; `''` means no cwd clause. */
  readonly cwd: string
}

const EMPTY_RESULT: SearchView = { hits: [], total: 0, hasMore: false }

/** Search the session index within the caller's read scope and filters. */
export async function searchSessions(
  ctx: HostContext,
  options: SearchOptions,
  signal?: AbortSignal,
): Promise<SearchView> {
  // A profile without the search service cannot answer, so the capability
  // check comes before permission scoping.
  const service = requireSessionQuery(ctx)

  const allowed = await allowedSessionIds(ctx, options)
  if (allowed !== undefined && allowed.length === 0) return EMPTY_RESULT

  const result = await executeSessionSearch(service, buildRequest(options, allowed), signal)
  const items = Array.isArray(result.items) ? result.items : []

  return {
    hits: await toHits(ctx, items),
    total: items.length,
    hasMore: typeof result.nextCursor === 'string' && result.nextCursor !== '',
  }
}

/**
 * Session ids the caller may search, or `undefined` for "no id restriction".
 *
 * `all` with no filters searches the whole index. Any scope or filter needs
 * the session listing to decide, so a missing listing degrades to "nothing is
 * visible" instead of silently searching the whole index.
 */
async function allowedSessionIds(
  ctx: HostContext,
  options: SearchOptions,
): Promise<string[] | undefined> {
  if (options.scope === 'all' && !hasAnyFilter(options.filters)) return undefined

  const controller = serviceOf(ctx, HostService.SessionController) as
    | SessionController
    | null
    | undefined
  if (controller === undefined || controller === null || typeof controller.list !== 'function') {
    return []
  }

  let items: readonly SessionSummary[]
  try {
    items = await listSessionItems(controller)
  } catch {
    return []
  }

  const workspaces = await loadWorkspaces(readServices(ctx).workspaces)
  const owners = await readOwnerIndex()
  const allowed: string[] = []

  for (const item of items) {
    const sessionId = sessionIdOf(item)
    if (sessionId === '') continue
    const visible = isSessionVisible(
      {
        sessionId,
        ownerId: owners[sessionId]?.ownerSessionId ?? '',
        cwd: sessionCwd(item),
        workspace: workspaceForSession(item, workspaces),
      },
      options,
    )
    if (visible) allowed.push(sessionId)
  }

  return allowed
}

/** Build the request, omitting `sessionFilters` entirely when nothing filters. */
function buildRequest(
  options: SearchOptions,
  allowed: readonly string[] | undefined,
): SessionSearchRequest {
  const sessionFilters = buildFilters(options, allowed)
  const request: SessionSearchRequest = { query: options.query, limit: options.limit }
  return sessionFilters === undefined ? request : { ...request, sessionFilters }
}

function buildFilters(
  options: SearchOptions,
  allowed: readonly string[] | undefined,
): SessionSearchFilter[] | undefined {
  const filters: SessionSearchFilter[] = []
  if (options.cwd !== '') filters.push({ kind: 'cwd', values: [options.cwd] })
  if (allowed !== undefined) filters.push({ kind: 'id', values: allowed })
  return filters.length === 0 ? undefined : filters
}

/**
 * Collapse hits per session, keeping the first (best) match, then complete
 * titles. A hit without a usable session id is dropped.
 */
async function toHits(
  ctx: HostContext,
  items: readonly SessionSearchItem[],
): Promise<SearchHit[]> {
  const seen = new Set<string>()
  const matched: { readonly sessionId: string; readonly snippet: string }[] = []

  for (const item of items) {
    const sessionId = sessionIdOf(item.header ?? {})
    if (sessionId === '' || seen.has(sessionId)) continue
    seen.add(sessionId)
    matched.push({ sessionId, snippet: snippetOf(item) })
  }
  if (matched.length === 0) return []

  const titles = await readSessionTitles(ctx)
  return matched.map(({ sessionId, snippet }) => ({
    sessionId,
    title: titles.get(sessionId) ?? '',
    snippet,
  }))
}

function snippetOf(item: SessionSearchItem): string {
  const snippet = item.bestMatch?.snippet
  return typeof snippet === 'string' ? snippet : ''
}
