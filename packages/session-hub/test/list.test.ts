import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'

import { ownerIndexPath } from '../src/host/owner-index.js'
import { createReadTools } from '../src/tools/read.js'
import type { HostContext } from '../src/shared/types.js'
import {
  createTempHome,
  executeTool,
  removeTempHome,
  serviceContext,
  toolByName,
  type FakeExec,
} from './helpers/fixtures.js'

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

function sessionListTool(ctx: HostContext) {
  return toolByName(createReadTools(ctx), 'session_list')
}

async function runList(args: unknown, ctx: HostContext = createCtx()): Promise<string> {
  return executeTool(sessionListTool(ctx), args, exec)
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
})
