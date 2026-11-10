/**
 * `session_search` behaviour, exercised through the real tool.
 *
 * The host search service is faked at the `ctx.get` boundary so every
 * assertion sees both the outward text and the exact request the plugin sent —
 * which is where the read scope and filters become observable.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { ownerIndexPath } from '../src/host/owner-index.js'
import { ToolName } from '../src/shared/enums.js'
import type { HostContext } from '../src/shared/types.js'
import { createTools } from '../src/tools/registry.js'
import { createSearchTool } from '../src/tools/search.js'
import {
  createTempHome,
  executeTool,
  removeTempHome,
  serviceContext,
  type FakeExec,
} from './helpers/fixtures.js'
import { createSettings } from './helpers/settings.js'

const callerId = 'caller'
const alphaDir = path.resolve('/fixtures/alpha')
const betaDir = path.resolve('/fixtures/beta')

interface SearchFilter {
  readonly kind: string
  readonly values: readonly string[]
}

interface SearchRequest {
  readonly query: string
  readonly limit?: number
  readonly sessionFilters?: readonly SearchFilter[]
}

interface SearchItem {
  readonly header?: { readonly id?: unknown }
  readonly bestMatch?: { readonly sessionId?: unknown; readonly snippet?: unknown }
}

interface SearchPage {
  readonly items?: readonly SearchItem[]
  readonly nextCursor?: string
}

interface SearchCall {
  readonly request: SearchRequest
  readonly exec: unknown
}

interface TitleEntry {
  readonly sessionId: string
  readonly title: string
  readonly cwd?: string
  readonly workspaceId?: string
}

interface WorkspaceEntry {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly sessionIds?: readonly string[]
}

interface HarnessOptions {
  readonly items?: readonly SearchItem[]
  readonly nextCursor?: string
  readonly searchError?: Error
  readonly withSearch?: boolean
  readonly titles?: readonly TitleEntry[]
  readonly workspaces?: readonly WorkspaceEntry[]
}

interface Harness {
  readonly ctx: HostContext
  readonly calls: SearchCall[]
}

/** A host context whose search and listing services record what they receive. */
function createHarness(options: HarnessOptions = {}): Harness {
  const calls: SearchCall[] = []
  const titles = options.titles ?? []
  const services: Record<string, unknown> = {
    sessionController: {
      list: async () => ({
        items: titles.map(({ sessionId, title, cwd, workspaceId }) => ({
          sessionId,
          cwd,
          workspaceId,
          projections: { values: { title } },
        })),
      }),
    },
    workspaceRegistry: {
      list: async () => options.workspaces ?? [],
      archivedSessionIds: [],
    },
  }

  if (options.withSearch !== false) {
    services.sessionQuery = {
      searchSessions: async (request: SearchRequest, exec?: unknown): Promise<SearchPage> => {
        calls.push({ request, exec })
        if (options.searchError !== undefined) throw options.searchError
        const items = options.items ?? []
        return options.nextCursor === undefined ? { items } : { items, nextCursor: options.nextCursor }
      },
    }
  }

  return { ctx: serviceContext(services), calls }
}

const exec: FakeExec = { agent: { id: callerId }, signal: undefined }

function execWithCwd(cwd: string): FakeExec {
  return { agent: { id: callerId, session: { header: { cwd } } }, signal: undefined }
}

function searchTool(ctx: HostContext, settings = createSettings()): ToolDefinition {
  return createSearchTool(ctx, settings)
}

async function runSearch(
  args: unknown,
  ctx: HostContext = createHarness().ctx,
  settings = createSettings(),
  execContext: FakeExec = exec,
): Promise<string> {
  return executeTool(searchTool(ctx, settings), args, execContext)
}

function writeOwners(owners: Record<string, { readonly ownerSessionId: string }>): void {
  const file = ownerIndexPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(owners), 'utf8')
}

describe('session_search', () => {
  const tempHome = createTempHome('session-hub-search-')

  beforeEach(() => {
    process.env.DSH_HOME = tempHome
    writeOwners({})
  })

  after(() => {
    removeTempHome(tempHome)
  })

  test('the default scope sends no id filter and deduplicates hits per session', async () => {
    const { ctx, calls } = createHarness({
      items: [
        { header: { id: 's1' }, bestMatch: { sessionId: 's1', snippet: 'first alpha' } },
        { header: { id: 's2' }, bestMatch: { sessionId: 's2', snippet: 'beta' } },
        { header: { id: 's1' }, bestMatch: { sessionId: 's1', snippet: 'second alpha' } },
        { header: { id: 's3' }, bestMatch: { sessionId: 's3', snippet: 'gamma' } },
        { bestMatch: { sessionId: 'orphan', snippet: 'orphan snippet' } },
      ],
      titles: [
        { sessionId: 's1', title: 'Alpha session' },
        { sessionId: 's2', title: 'Beta session' },
      ],
    })

    const text = await runSearch({ query: 'alpha' }, ctx)

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.request.query, 'alpha')
    assert.equal(calls[0]?.request.limit, 20)
    assert.equal(calls[0]?.request.sessionFilters, undefined)

    assert.match(text, /^ID\s+TITLE\s+SNIPPET/)
    assert.match(text, /s1\s+Alpha session\s+first alpha/)
    assert.match(text, /s2\s+Beta session\s+beta/)
    assert.match(text, /s3\s+-\s+gamma/)
    assert.doesNotMatch(text, /second alpha/)
    assert.doesNotMatch(text, /orphan/)
    assert.match(text, /共 5 条命中，涉及 3 个会话（显示 3 个）$/)
  })

  test('scope "owned" only asks for sessions the caller created', async () => {
    writeOwners({
      created: { ownerSessionId: callerId },
      foreign: { ownerSessionId: 'someone-else' },
    })
    const { ctx, calls } = createHarness({
      titles: [
        { sessionId: callerId, title: 'Caller' },
        { sessionId: 'created', title: 'Created' },
        { sessionId: 'foreign', title: 'Foreign' },
      ],
    })
    const settings = createSettings({ [ToolName.SessionSearch]: { scope: 'owned' } })

    await runSearch({ query: 'needle' }, ctx, settings)

    assert.equal(calls.length, 1)
    // Only the owner index counts; the caller's own unrecorded session is not
    // "owned by the caller" and is therefore outside the scope.
    assert.deepEqual(calls[0]?.request.sessionFilters, [
      { kind: 'id', values: ['created'] },
    ])
  })

  test('scope "owned" with an empty scope returns before calling searchSessions', async () => {
    const { ctx, calls } = createHarness()
    const settings = createSettings({ [ToolName.SessionSearch]: { scope: 'owned' } })

    const text = await runSearch({ query: 'needle' }, ctx, settings, { agent: {} })

    assert.deepEqual(calls, [])
    assert.equal(text, '没有匹配的会话。')
  })

  test('scope "workspace" only asks for sessions at the caller cwd', async () => {
    const { ctx, calls } = createHarness({
      titles: [
        { sessionId: 's1', title: 'Alpha', cwd: alphaDir },
        { sessionId: 's2', title: 'Beta', cwd: betaDir },
        { sessionId: 's3', title: 'Alpha sub', cwd: path.join(alphaDir, 'sub') },
      ],
    })
    const settings = createSettings({ [ToolName.SessionSearch]: { scope: 'workspace' } })

    await runSearch({ query: 'needle' }, ctx, settings, execWithCwd(alphaDir))

    assert.deepEqual(calls[0]?.request.sessionFilters, [{ kind: 'id', values: ['s1'] }])
  })

  test('filters.denySessions and allowSessions become an id filter', async () => {
    const { ctx, calls } = createHarness({
      titles: [
        { sessionId: 's1', title: 'One' },
        { sessionId: 's2', title: 'Two' },
        { sessionId: 's3', title: 'Three' },
      ],
    })
    const settings = createSettings(
      {},
      { filters: { allowSessions: ['s1', 's2'], denySessions: ['s1'] } },
    )

    await runSearch({ query: 'needle' }, ctx, settings)

    assert.deepEqual(calls[0]?.request.sessionFilters, [{ kind: 'id', values: ['s2'] }])
  })

  test('filters.allowWorkspaces keeps sessions of the listed workspaces', async () => {
    const workspaces = [{ id: 'ws-alpha', title: 'Alpha', path: alphaDir }]
    const { ctx, calls } = createHarness({
      workspaces,
      titles: [
        { sessionId: 's1', title: 'Alpha', cwd: alphaDir },
        { sessionId: 's2', title: 'Beta', cwd: betaDir },
      ],
    })
    const settings = createSettings({}, { filters: { allowWorkspaces: ['ws-alpha'] } })

    await runSearch({ query: 'needle' }, ctx, settings)

    assert.deepEqual(calls[0]?.request.sessionFilters, [{ kind: 'id', values: ['s1'] }])
  })

  test('a configured id scope that matches nothing returns before searching', async () => {
    const { ctx, calls } = createHarness({ titles: [{ sessionId: 's2', title: 'Beta' }] })
    const settings = createSettings({}, { filters: { allowSessions: ['s1'] } })

    const text = await runSearch({ query: 'needle' }, ctx, settings)

    assert.deepEqual(calls, [])
    assert.equal(text, '没有匹配的会话。')
  })

  test('missing sessionQuery reports SEARCH_UNAVAILABLE', async () => {
    const { ctx } = createHarness({ withSearch: false })

    const text = await runSearch({ query: 'alpha' }, ctx)

    assert.equal(
      text,
      'session-hub: SEARCH_UNAVAILABLE: sessionQuery service is unavailable in this profile',
    )
  })

  test('a failing searchSessions reports SEARCH_FAILED with its message', async () => {
    const { ctx } = createHarness({ searchError: new Error('index is closed') })

    const text = await runSearch({ query: 'alpha' }, ctx)

    assert.equal(text, 'session-hub: SEARCH_FAILED: index is closed')
  })

  test('cwd is forwarded as an exact session filter', async () => {
    const { ctx, calls } = createHarness()

    await runSearch({ query: 'alpha', cwd: alphaDir }, ctx)

    assert.deepEqual(calls[0]?.request.sessionFilters, [
      { kind: 'cwd', values: [alphaDir] },
    ])
  })

  test('a blank query is rejected before any host call', async () => {
    const { ctx, calls } = createHarness()

    const text = await runSearch({ query: '   ' }, ctx)

    assert.equal(text, 'session-hub: query is required')
    assert.deepEqual(calls, [])
  })

  test('clamps limit, truncates snippets and reports more results', async () => {
    const snippet = 'x'.repeat(250)
    const { ctx, calls } = createHarness({
      items: [{ header: { id: 's1' }, bestMatch: { sessionId: 's1', snippet } }],
      nextCursor: 'cursor-2',
    })

    const text = await runSearch({ query: 'x', limit: 999 }, ctx)

    assert.equal(calls[0]?.request.limit, 50)
    assert.match(text, /x{200}…/)
    assert.doesNotMatch(text, /x{201}/)
    assert.match(text, /^共 1 条命中，涉及 1 个会话（显示 1 个）$/m)
    assert.match(text, /（还有更多结果，请缩小查询）$/)
  })

  test('the configured limit is the default page size', async () => {
    const { ctx, calls } = createHarness()
    const settings = createSettings({ [ToolName.SessionSearch]: { limit: 7 } })

    const text = await runSearch({ query: 'alpha' }, ctx, settings)

    assert.equal(calls[0]?.request.limit, 7)
    assert.equal(text, '没有匹配的会话。')
  })

  test('session_search schema only declares query, limit and cwd', () => {
    const tool = searchTool(createHarness().ctx)
    const parameters = tool.parameters as unknown as {
      readonly required: readonly string[]
      readonly properties: Record<string, Record<string, unknown>>
    }

    assert.equal(tool.name, 'session_search')
    assert.deepEqual(parameters.required, ['query'])
    assert.deepEqual(Object.keys(parameters.properties).sort(), ['cwd', 'limit', 'query'])
    assert.equal('confirm' in parameters.properties, false)
    assert.equal(parameters.properties.limit?.type, 'integer')
    assert.equal(parameters.properties.limit?.default, 20)
    assert.match(String(parameters.properties.limit?.description), /default 20, max 50/)
  })

  test('the registry registers ten tools by default', () => {
    const expected = [
      'session_list',
      'session_get',
      'session_create',
      'session_update',
      'session_close',
      'session_open',
      'session_send',
      'session_wake',
      'session_wait',
      'session_search',
    ]

    assert.deepEqual(
      createTools(createHarness().ctx, createSettings()).map((tool) => tool.name),
      expected,
    )
  })
})
