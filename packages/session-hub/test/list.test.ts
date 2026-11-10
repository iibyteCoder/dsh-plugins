import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'

import { ownerIndexPath } from '../src/host/owner-index.js'
import { createReadTools } from '../src/tools/read.js'
import { ToolName } from '../src/shared/enums.js'
import type { HostContext } from '../src/shared/types.js'
import {
  createTempHome,
  executeTool,
  removeTempHome,
  serviceContext,
  toolByName,
  type FakeExec,
} from './helpers/fixtures.js'
import { createSettings } from './helpers/settings.js'

const callerId = 'caller'
const alphaDir = path.resolve('/fixtures/alpha')
const betaDir = path.resolve('/fixtures/beta')
const alphaSubDir = path.join(alphaDir, 'sub')

interface SessionItem {
  readonly sessionId: string
  readonly cwd?: string
  readonly running?: boolean
  readonly blank?: boolean
  readonly updatedAt?: unknown
  readonly projections?: { readonly values?: Record<string, unknown> }
}

const workspace = {
  id: 'ws-alpha',
  title: 'Alpha Workspace',
  path: alphaDir,
  sessionIds: ['s1'],
}

const items: readonly SessionItem[] = [
  {
    sessionId: 's1',
    cwd: alphaDir,
    running: true,
    updatedAt: Date.UTC(2026, 0, 2, 3, 4),
    projections: {
      values: { title: 'Fix login bug', modelSelection: { model: 'deepseek-chat' } },
    },
  },
  {
    sessionId: 's2',
    cwd: betaDir,
    blank: true,
    updatedAt: Date.UTC(2026, 0, 3, 4, 5),
    projections: {
      values: { title: 'Beta scratch', modelSelection: { model: 'deepseek-reasoner' } },
    },
  },
  {
    sessionId: 's3',
    cwd: alphaSubDir,
    updatedAt: '2026-01-04T05:06:00.000Z',
    projections: { values: { title: 'Docs update' } },
  },
]

function createCtx(overrides: Record<string, unknown> = {}): HostContext {
  return serviceContext({
    sessionController: { list: async () => ({ items }) },
    workspaceRegistry: {
      list: () => [workspace],
      archivedSessionIds: [] as string[],
    },
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
    ...overrides,
  })
}

const exec: FakeExec = { agent: { id: callerId }, signal: undefined }

function execWithCwd(cwd: string): FakeExec {
  return { agent: { id: callerId, session: { header: { cwd } } }, signal: undefined }
}

function sessionListTool(ctx: HostContext, settings = createSettings()) {
  return toolByName(createReadTools(ctx, settings), 'session_list')
}

async function runList(
  args: unknown,
  ctx: HostContext = createCtx(),
  settings = createSettings(),
  execContext: FakeExec = exec,
): Promise<string> {
  return executeTool(sessionListTool(ctx, settings), args, execContext)
}

function writeOwners(owners: Record<string, { ownerSessionId: string; createdAt?: number }>): void {
  const file = ownerIndexPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(owners), 'utf8')
}

describe('session_list', () => {
  const tempHome = createTempHome('session-hub-list-')

  beforeEach(() => {
    process.env.DSH_HOME = tempHome
    writeOwners({})
  })

  after(() => {
    removeTempHome(tempHome)
  })

  test('session_list returns every session by default', async () => {
    const text = await runList({})

    assert.match(text, /^ID\s+TITLE\s+WORKSPACE\s+CWD\s+STATUS\s+MODEL\s+OWNER\s+UPDATED/)
    assert.match(
      text,
      /s1\s+Fix login bug\s+Alpha Workspace\s+.*\s+running\s+deepseek-chat\s+-\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}/,
    )
    assert.match(text, /s2\s+Beta scratch\s+-\s+.*\s+blank\s+deepseek-reasoner\s+-/)
    assert.match(text, /s3\s+Docs update\s+Alpha Workspace\s+.*\s+idle\s+-/)
    assert.match(text, /共 3 个会话（显示 3 个）$/)
  })

  test('session_list filters by exact normalized cwd', async () => {
    const text = await runList({ cwd: alphaDir.toUpperCase() })

    assert.match(text, /s1\s+Fix login bug/)
    assert.doesNotMatch(text, /s2/)
    assert.doesNotMatch(text, /s3/)
    assert.match(text, /共 1 个会话（显示 1 个）$/)
  })

  test('session_list filters by case-insensitive title substring', async () => {
    const text = await runList({ title_contains: 'DOCS' })

    assert.match(text, /s3\s+Docs update/)
    assert.doesNotMatch(text, /s1/)
    assert.doesNotMatch(text, /s2/)
    assert.match(text, /共 1 个会话（显示 1 个）$/)
  })

  test('session_list filters by workspace title and path membership', async () => {
    const text = await runList({ workspace: 'Alpha Workspace' })

    assert.match(text, /s1\s+Fix login bug/)
    assert.match(text, /s3\s+Docs update/)
    assert.doesNotMatch(text, /s2/)
    assert.match(text, /共 2 个会话（显示 2 个）$/)
  })

  test('session_list filters by owner self using the owner index', async () => {
    writeOwners({ s2: { ownerSessionId: callerId, createdAt: Date.UTC(2026, 0, 3) } })

    const text = await runList({ owner: 'self' })

    assert.match(text, /s2\s+Beta scratch\s+-\s+.*\s+blank\s+deepseek-reasoner\s+self/)
    assert.doesNotMatch(text, /s1/)
    assert.doesNotMatch(text, /s3/)
    assert.match(text, /共 1 个会话（显示 1 个）$/)
  })

  test('session_list filters by archived status', async () => {
    const ctx = createCtx({
      workspaceRegistry: { list: () => [workspace], archivedSessionIds: ['s3'] },
    })

    const text = await runList({ status: 'archived' }, ctx)

    assert.match(text, /s3\s+Docs update\s+Alpha Workspace\s+.*\s+archived/)
    assert.doesNotMatch(text, /s1/)
    assert.doesNotMatch(text, /s2/)
    assert.match(text, /共 1 个会话（显示 1 个）$/)
  })

  test('session_list applies limit while reporting the full match count', async () => {
    const text = await runList({ limit: 2 })

    assert.match(text, /s1\s+Fix login bug/)
    assert.match(text, /s2\s+Beta scratch/)
    assert.doesNotMatch(text, /s3/)
    assert.match(text, /共 3 个会话（显示 2 个）$/)
  })

  test('session_list returns a message when nothing matches', async () => {
    const text = await runList({ title_contains: 'no-such-title' })
    assert.equal(text, '未找到匹配的会话。')
  })

  test('session_list returns an error text when sessionController is missing', async () => {
    const text = await runList({}, createCtx({ sessionController: undefined }))

    assert.equal(typeof text, 'string')
    assert.equal(text, 'session-hub: sessionController service is unavailable in this profile')
  })

  test('scope "workspace" only shows sessions at the caller cwd', async () => {
    const settings = createSettings({ [ToolName.SessionList]: { scope: 'workspace' } })

    const text = await runList({}, createCtx(), settings, execWithCwd(alphaDir))

    assert.match(text, /s1\s+Fix login bug/)
    assert.doesNotMatch(text, /s2/)
    assert.doesNotMatch(text, /s3/)
    assert.match(text, /共 1 个会话（显示 1 个）$/)
  })

  test('scope "workspace" hides everything when the caller cwd is unknown', async () => {
    const settings = createSettings({ [ToolName.SessionList]: { scope: 'workspace' } })

    const text = await runList({}, createCtx(), settings, { agent: { id: callerId } })

    assert.equal(text, '未找到匹配的会话。')
  })

  test('scope "owned" only shows sessions created by the caller', async () => {
    writeOwners({ s2: { ownerSessionId: callerId } })
    const settings = createSettings({ [ToolName.SessionList]: { scope: 'owned' } })

    const text = await runList({}, createCtx(), settings)

    assert.match(text, /s2\s+Beta scratch/)
    assert.doesNotMatch(text, /s1/)
    assert.doesNotMatch(text, /s3/)
    assert.match(text, /共 1 个会话（显示 1 个）$/)
  })

  test('scope "owned" requires an identified caller', async () => {
    writeOwners({ s2: { ownerSessionId: callerId } })
    const settings = createSettings({ [ToolName.SessionList]: { scope: 'owned' } })

    const text = await runList({}, createCtx(), settings, { agent: {} })

    assert.equal(text, '未找到匹配的会话。')
  })

  test('filters.denySessions removes a session', async () => {
    const settings = createSettings({}, { filters: { denySessions: ['s2'] } })

    const text = await runList({}, createCtx(), settings)

    assert.match(text, /s1\s+Fix login bug/)
    assert.doesNotMatch(text, /s2/)
    assert.match(text, /共 2 个会话（显示 2 个）$/)
  })

  test('filters.allowSessions restricts the list to the allow list', async () => {
    const settings = createSettings({}, { filters: { allowSessions: ['s2'] } })

    const text = await runList({}, createCtx(), settings)

    assert.doesNotMatch(text, /s1/)
    assert.match(text, /s2\s+Beta scratch/)
    assert.doesNotMatch(text, /s3/)
    assert.match(text, /共 1 个会话（显示 1 个）$/)
  })

  test('filters.denyWorkspaces removes every session of that workspace', async () => {
    const settings = createSettings({}, { filters: { denyWorkspaces: ['Alpha Workspace'] } })

    const text = await runList({}, createCtx(), settings)

    assert.doesNotMatch(text, /s1/)
    assert.match(text, /s2\s+Beta scratch/)
    assert.doesNotMatch(text, /s3/)
    assert.match(text, /共 1 个会话（显示 1 个）$/)
  })

  test('filters.allowWorkspaces keeps only sessions of the listed workspaces', async () => {
    const settings = createSettings({}, { filters: { allowWorkspaces: ['ws-alpha'] } })

    const text = await runList({}, createCtx(), settings, execWithCwd(alphaDir))

    assert.match(text, /s1\s+Fix login bug/)
    assert.doesNotMatch(text, /s2/)
    assert.match(text, /s3\s+Docs update/)
    assert.match(text, /共 2 个会话（显示 2 个）$/)
  })

  test('deny wins over allow', async () => {
    const settings = createSettings(
      {},
      { filters: { allowSessions: ['s1', 's2'], denySessions: ['s1'] } },
    )

    const text = await runList({}, createCtx(), settings)

    assert.doesNotMatch(text, /s1/)
    assert.match(text, /s2\s+Beta scratch/)
    assert.match(text, /共 1 个会话（显示 1 个）$/)
  })

  test('the configured status is the default status filter', async () => {
    const settings = createSettings({ [ToolName.SessionList]: { status: 'running' } })

    const text = await runList({}, createCtx(), settings)

    assert.match(text, /s1\s+Fix login bug/)
    assert.doesNotMatch(text, /s2/)
    assert.doesNotMatch(text, /s3/)
    assert.match(text, /共 1 个会话（显示 1 个）$/)
  })

  test('the configured limit is the default page size', async () => {
    const settings = createSettings({ [ToolName.SessionList]: { limit: 2 } })

    const text = await runList({}, createCtx(), settings)

    assert.match(text, /s1\s+Fix login bug/)
    assert.match(text, /s2\s+Beta scratch/)
    assert.doesNotMatch(text, /s3/)
    assert.match(text, /共 3 个会话（显示 2 个）$/)
  })
})
