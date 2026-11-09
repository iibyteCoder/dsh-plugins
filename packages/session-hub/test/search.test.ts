/**
 * `session_search` behaviour, exercised through the real tool.
 *
 * The host search service is faked at the `ctx.get` boundary so every
 * assertion sees both the outward text and the exact request the plugin sent —
 * which is where the permission mode becomes observable.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { ownerIndexPath } from '../src/host/owner-index.js'
import { PermissionMode } from '../src/shared/enums.js'
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

const callerId = 'caller'
const alphaDir = path.resolve('/fixtures/alpha')

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

interface HarnessOptions {
  readonly items?: readonly SearchItem[]
  readonly nextCursor?: string
  readonly searchError?: Error
  readonly withSearch?: boolean
  readonly titles?: readonly { readonly sessionId: string; readonly title: string }[]
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
        items: titles.map(({ sessionId, title }) => ({
          sessionId,
          projections: { values: { title } },
        })),
      }),
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

function searchTool(ctx: HostContext, permissionMode: PermissionMode): ToolDefinition {
  return createSearchTool(ctx, { permissionMode })
}

async function runSearch(
  args: unknown,
  ctx: HostContext = createHarness().ctx,
  permissionMode: PermissionMode = PermissionMode.Permissive,
  execContext: FakeExec = exec,
): Promise<string> {
  return executeTool(searchTool(ctx, permissionMode), args, execContext)
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

  test('permissive search sends no id filter and deduplicates hits per session', async () => {
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

  test('owned search only asks for the caller and the sessions it created', async () => {
    writeOwners({
      created: { ownerSessionId: callerId },
      foreign: { ownerSessionId: 'someone-else' },
    })
    const { ctx, calls } = createHarness()

    await runSearch({ query: 'needle' }, ctx, PermissionMode.Owned)

    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0]?.request.sessionFilters, [
      { kind: 'id', values: [callerId, 'created'] },
    ])
  })

  test('owned search with an empty scope returns before calling searchSessions', async () => {
    const { ctx, calls } = createHarness()

    const text = await runSearch(
      { query: 'needle' },
      ctx,
      PermissionMode.Owned,
      { agent: {} },
    )

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

  test('session_search schema only declares query, limit and cwd in both modes', () => {
    for (const permissionMode of [PermissionMode.Permissive, PermissionMode.Owned]) {
      const tool = searchTool(createHarness().ctx, permissionMode)
      const parameters = tool.parameters as unknown as {
        readonly required: readonly string[]
        readonly properties: Record<string, Record<string, unknown>>
      }

      assert.equal(tool.name, 'session_search')
      assert.deepEqual(parameters.required, ['query'])
      assert.deepEqual(Object.keys(parameters.properties).sort(), ['cwd', 'limit', 'query'])
      assert.equal('confirm' in parameters.properties, false, permissionMode)
      assert.equal(parameters.properties.limit?.type, 'integer')
      assert.equal(parameters.properties.limit?.default, 20)
      assert.match(String(parameters.properties.limit?.description), /default 20, max 50/)
    }
  })

  test('the registry registers ten tools in both permission modes', () => {
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
    const ctx = createHarness().ctx

    for (const permissionMode of [PermissionMode.Permissive, PermissionMode.Owned]) {
      assert.deepEqual(
        createTools(ctx, { permissionMode }).map((tool) => tool.name),
        expected,
        `unexpected tool list in ${permissionMode} mode`,
      )
    }
  })
})
