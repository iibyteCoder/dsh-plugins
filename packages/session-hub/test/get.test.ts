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
const createdAt = Date.UTC(2026, 0, 2, 3, 4)

const events = [
  {
    type: 'user/message',
    data: {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hello there' }],
    },
  },
  {
    type: 'assistant/message',
    data: {
      content: [{ type: 'text', text: 'hi, how can I help?' }],
    },
  },
  {
    type: 'plugin:session-hub/owner',
    data: { ownerSessionId: callerId },
  },
]

function createCtx(overrides: Record<string, unknown> = {}): HostContext {
  return serviceContext({
    sessionController: {
      inspect: async (id: string) => {
        if (id !== 's1') throw new Error(`session ${id} not found`)
        return {
          meta: {
            id: 's1',
            createdAt,
            cwd: alphaDir,
            parentSession: 's0',
            origin: 'cli',
            agentPreset: 'default',
          },
          inheritedEventCount: events.length,
          events,
        }
      },
      list: async () => ({ items: [{ sessionId: 's1', cwd: alphaDir }] }),
    },
    workspaceRegistry: {
      list: () => [{ id: 'ws-alpha', title: 'Alpha Workspace', path: alphaDir }],
      archivedSessionIds: [] as string[],
    },
    sessions: { get: () => undefined },
    agents: { get: (id: string) => (id === 's1' ? { status: 'running' } : undefined) },
    ...overrides,
  })
}

const exec: FakeExec = { agent: { id: callerId }, signal: undefined }

function sessionGetTool(ctx: HostContext) {
  return toolByName(createReadTools(ctx), 'session_get')
}

async function runGet(args: unknown, ctx: HostContext = createCtx()): Promise<string> {
  return executeTool(sessionGetTool(ctx), args, exec)
}

function writeOwners(owners: Record<string, { ownerSessionId: string; createdAt?: number }>): void {
  const file = ownerIndexPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(owners), 'utf8')
}

describe('session_get', () => {
  const tempHome = createTempHome('session-hub-get-')

  beforeEach(() => {
    process.env.DSH_HOME = tempHome
    writeOwners({ s1: { ownerSessionId: callerId, createdAt } })
  })

  after(() => {
    removeTempHome(tempHome)
  })

  test('session_get renders the session header and metadata', async () => {
    const text = await runGet({ session_id: 's1' })

    assert.ok(text.startsWith('会话 s1\n'))
    assert.match(text, /^- id: s1$/m)
    assert.match(text, /^- createdAt: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m)
    assert.match(text, /^- cwd: .+$/m)
    assert.ok(text.includes(alphaDir))
    assert.match(text, /^- parentSession: s0$/m)
    assert.match(text, /^- origin: cli$/m)
    assert.match(text, /^- agentPreset: default$/m)
    assert.match(text, /^- status: running$/m)
    assert.match(text, /^- owner: self$/m)
    assert.doesNotMatch(text, /最近消息：/)
  })

  test('session_get includes the last two user/assistant messages only', async () => {
    const text = await runGet({ session_id: 's1', include_recent: 2 })

    assert.match(text, /最近消息：/)
    assert.match(text, /1\. \[user:user\] hello there/)
    assert.match(text, /2\. \[assistant\] hi, how can I help\?/)
    assert.doesNotMatch(text, /plugin:session-hub\/owner/)
  })

  test('session_get include_recent slices from the end', async () => {
    const text = await runGet({ session_id: 's1', include_recent: 1 })

    assert.match(text, /1\. \[assistant\] hi, how can I help\?/)
    assert.doesNotMatch(text, /hello there/)
  })

  test('session_get returns a not-found error text for unknown sessions', async () => {
    const text = await runGet({ session_id: 'missing' })

    assert.equal(text, 'session-hub: session "missing" not found')
  })

  test('session_get falls back to the listed session status when no live agent exists', async () => {
    const ctx = createCtx({
      agents: { get: () => undefined },
      sessionController: {
        inspect: async () => ({ meta: { id: 's1' }, events: [] }),
        list: async () => ({ items: [{ sessionId: 's1', running: true }] }),
      },
    })

    const text = await runGet({ session_id: 's1' }, ctx)
    assert.match(text, /^- status: running$/m)
  })

  test('session_get returns an error text when sessionController is missing', async () => {
    const text = await runGet({ session_id: 's1' }, createCtx({ sessionController: undefined }))

    assert.equal(text, 'session-hub: sessionController service is unavailable in this profile')
  })
})
