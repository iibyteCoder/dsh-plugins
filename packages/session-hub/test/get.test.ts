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
const createdAt = Date.UTC(2026, 0, 2, 3, 4)

/** A durable host session header, including the fields session_get renders. */
const header: Record<string, unknown> = {
  version: 4,
  id: 's1',
  createdAt,
  cwd: alphaDir,
  parentSession: 's0',
  isSeeded: false,
  origin: 'subagent',
  agentPreset: 'default',
}

/**
 * Events in the host log shape: `user/message` carries its content directly,
 * while `assistant/message` wraps the message under `message`.
 */
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
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi, how can I help?' }],
      },
    },
  },
  {
    type: 'plugin:session-hub/owner',
    data: { ownerSessionId: callerId },
  },
]

interface ObservationCall {
  readonly sessionId: string
  readonly options: Record<string, unknown>
}

function createCtx(overrides: Record<string, unknown> = {}): HostContext {
  return serviceContext({
    sessionController: {
      list: async () => ({ items: [{ sessionId: 's1', cwd: alphaDir }] }),
    },
    workspaceRegistry: {
      list: () => [{ id: 'ws-alpha', title: 'Alpha Workspace', path: alphaDir }],
      archivedSessionIds: [] as string[],
    },
    sessions: {
      get: (id: string) => (id === 's1' ? { header, snapshotEvents: () => events } : undefined),
    },
    agents: { get: (id: string) => (id === 's1' ? { status: 'running' } : undefined) },
    ...overrides,
  })
}

const exec: FakeExec = { agent: { id: callerId }, signal: undefined }

function execWithCwd(cwd: string): FakeExec {
  return { agent: { id: callerId, session: { header: { cwd } } }, signal: undefined }
}

function sessionGetTool(ctx: HostContext, settings = createSettings()) {
  return toolByName(createReadTools(ctx, settings), 'session_get')
}

async function runGet(
  args: unknown,
  ctx: HostContext = createCtx(),
  context: FakeExec = exec,
  settings = createSettings(),
): Promise<string> {
  return executeTool(sessionGetTool(ctx, settings), args, context)
}

function writeOwners(owners: Record<string, { ownerSessionId: string; createdAt?: number }>): void {
  const file = ownerIndexPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(owners), 'utf8')
}

/** A cold read service whose observation can be inspected after the call. */
function coldQuery(calls: ObservationCall[], onDispose: () => void = () => {}) {
  return {
    observeSession: async (
      sessionId: string,
      options: Record<string, unknown> = {},
    ): Promise<unknown> => {
      calls.push({ sessionId, options })
      return {
        header,
        events,
        [Symbol.dispose]: onDispose,
      }
    },
  }
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

  test('session_get renders a live session header and metadata', async () => {
    const text = await runGet({ session_id: 's1' })

    assert.ok(text.startsWith('会话 s1\n'))
    assert.match(text, /^- id: s1$/m)
    assert.match(text, /^- createdAt: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m)
    assert.match(text, /^- cwd: .+$/m)
    assert.ok(text.includes(alphaDir))
    assert.match(text, /^- parentSession: s0$/m)
    assert.match(text, /^- origin: subagent$/m)
    assert.match(text, /^- agentPreset: default$/m)
    assert.match(text, /^- status: running$/m)
    assert.match(text, /^- owner: self$/m)
    // The configured default is ten recent messages, so both are rendered.
    assert.match(text, /最近消息：/)
    assert.match(text, /\[user:user\] hello there/)
    assert.match(text, /\[assistant\] hi, how can I help\?/)
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

  test('the configured recent count is the default', async () => {
    const settings = createSettings({ [ToolName.SessionGet]: { recent: 0 } })

    const text = await runGet({ session_id: 's1' }, createCtx(), exec, settings)

    assert.doesNotMatch(text, /最近消息：/)
  })

  test('the configured recent count is overridden by an explicit argument', async () => {
    const settings = createSettings({ [ToolName.SessionGet]: { recent: 2 } })

    const text = await runGet({ session_id: 's1', include_recent: 1 }, createCtx(), exec, settings)

    assert.match(text, /1\. \[assistant\] hi, how can I help\?/)
    assert.doesNotMatch(text, /hello there/)
  })

  test('scope "owned" rejects a session created by another session', async () => {
    writeOwners({ s1: { ownerSessionId: 'other' } })
    const settings = createSettings({ [ToolName.SessionGet]: { scope: 'owned' } })

    const text = await runGet({ session_id: 's1' }, createCtx(), exec, settings)

    assert.equal(
      text,
      'session-hub: SCOPE_DENIED: session "s1" is outside the configured read scope',
    )
  })

  test('scope "owned" allows a session created by the caller', async () => {
    const settings = createSettings({ [ToolName.SessionGet]: { scope: 'owned' } })

    const text = await runGet({ session_id: 's1' }, createCtx(), exec, settings)

    assert.match(text, /^- id: s1$/m)
  })

  test('scope "workspace" checks the caller and session cwd', async () => {
    const settings = createSettings({ [ToolName.SessionGet]: { scope: 'workspace' } })

    const allowed = await runGet({ session_id: 's1' }, createCtx(), execWithCwd(alphaDir), settings)
    assert.match(allowed, /^- id: s1$/m)

    const denied = await runGet({ session_id: 's1' }, createCtx(), execWithCwd(betaDir), settings)
    assert.equal(
      denied,
      'session-hub: SCOPE_DENIED: session "s1" is outside the configured read scope',
    )
  })

  test('filters.denySessions hides a session from session_get', async () => {
    const settings = createSettings({}, { filters: { denySessions: ['s1'] } })

    const text = await runGet({ session_id: 's1' }, createCtx(), exec, settings)

    assert.equal(
      text,
      'session-hub: SCOPE_DENIED: session "s1" is outside the configured read scope',
    )
  })

  test('filters.allowSessions hides a session that is not listed', async () => {
    const settings = createSettings({}, { filters: { allowSessions: ['someone-else'] } })

    const text = await runGet({ session_id: 's1' }, createCtx(), exec, settings)

    assert.equal(
      text,
      'session-hub: SCOPE_DENIED: session "s1" is outside the configured read scope',
    )
  })

  test('filters.allowWorkspaces matches the workspace of the session', async () => {
    const allowed = createSettings({}, { filters: { allowWorkspaces: ['Alpha Workspace'] } })
    const denied = createSettings({}, { filters: { allowWorkspaces: ['Beta Workspace'] } })

    assert.match(
      await runGet({ session_id: 's1' }, createCtx(), exec, allowed),
      /^- id: s1$/m,
    )
    assert.equal(
      await runGet({ session_id: 's1' }, createCtx(), exec, denied),
      'session-hub: SCOPE_DENIED: session "s1" is outside the configured read scope',
    )
  })

  test('session_get reads a cold session through sessionQuery.observeSession', async () => {
    const calls: ObservationCall[] = []
    let disposed = 0
    const ctx = createCtx({
      sessions: { get: () => undefined },
      sessionQuery: coldQuery(calls, () => {
        disposed += 1
      }),
    })

    const text = await runGet({ session_id: 's1', include_recent: 1 }, ctx)

    assert.ok(text.startsWith('会话 s1\n'))
    assert.match(text, /^- createdAt: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m)
    assert.match(text, /1\. \[assistant\] hi, how can I help\?/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.sessionId, 's1')
    assert.equal(calls[0]?.options.projectionMode, 'none')
    assert.equal('signal' in (calls[0]?.options ?? {}), false)
    assert.equal(disposed, 1)
  })

  test('session_get forwards the execution signal to the cold read', async () => {
    const calls: ObservationCall[] = []
    const controller = new AbortController()
    const ctx = createCtx({
      sessions: { get: () => undefined },
      sessionQuery: coldQuery(calls),
    })

    await runGet({ session_id: 's1' }, ctx, { agent: { id: callerId }, signal: controller.signal })

    assert.equal(calls[0]?.options.signal, controller.signal)
  })

  test('session_get reports GET_FAILED with the original read error', async () => {
    const ctx = createCtx({
      sessions: {
        get: () => {
          throw new Error('session store is offline')
        },
      },
      sessionQuery: {
        observeSession: async () => {
          throw new Error('session "s1" log is corrupt')
        },
      },
    })

    const text = await runGet({ session_id: 's1' }, ctx)

    assert.equal(text, 'session-hub: GET_FAILED: session "s1" log is corrupt')
  })

  test('session_get reports a not-found read with the host message, not a bare not found', async () => {
    const ctx = createCtx({
      sessions: { get: () => undefined },
      sessionQuery: {
        observeSession: async () => {
          throw new Error('session "missing" not found')
        },
      },
    })

    const text = await runGet({ session_id: 'missing' }, ctx)

    assert.equal(text, 'session-hub: GET_FAILED: session "missing" not found')
  })

  test('session_get falls back to the query when the live snapshot fails', async () => {
    const calls: ObservationCall[] = []
    const ctx = createCtx({
      sessions: {
        get: () => ({
          header,
          snapshotEvents: () => {
            throw new Error('live snapshot is broken')
          },
        }),
      },
      sessionQuery: coldQuery(calls),
    })

    const text = await runGet({ session_id: 's1' }, ctx)

    assert.match(text, /^- id: s1$/m)
    assert.equal(calls.length, 1)
  })

  test('session_get keeps the store error when the query service is missing', async () => {
    const ctx = createCtx({
      sessions: {
        get: () => {
          throw new Error('session store is offline')
        },
      },
      sessionQuery: undefined,
    })

    const text = await runGet({ session_id: 's1' }, ctx)

    assert.equal(text, 'session-hub: GET_FAILED: session store is offline')
  })

  test('session_get reports GET_FAILED when neither read service is available', async () => {
    const ctx = createCtx({ sessions: undefined, sessionQuery: undefined })

    const text = await runGet({ session_id: 's1' }, ctx)

    assert.equal(
      text,
      'session-hub: GET_FAILED: session "s1" cannot be read: neither the session store nor the session query service is available',
    )
  })

  test('session_get no longer depends on sessionController.inspect', async () => {
    const ctx = createCtx({
      sessionController: {
        list: async () => ({ items: [{ sessionId: 's1', cwd: alphaDir }] }),
        inspect: async () => {
          throw new Error('inspect is unavailable in this host')
        },
      },
    })

    const text = await runGet({ session_id: 's1' }, ctx)

    assert.match(text, /^- id: s1$/m)
    assert.doesNotMatch(text, /inspect is unavailable/)
  })

  test('session_get falls back to the listed session status when no live agent exists', async () => {
    const ctx = createCtx({
      agents: { get: () => undefined },
      sessions: { get: () => ({ header, snapshotEvents: () => [] }) },
      sessionController: {
        list: async () => ({ items: [{ sessionId: 's1', running: true }] }),
      },
    })

    const text = await runGet({ session_id: 's1' }, ctx)
    assert.match(text, /^- status: running$/m)
  })

  test('session_get renders without a sessionController service', async () => {
    const text = await runGet({ session_id: 's1' }, createCtx({ sessionController: undefined }))

    assert.match(text, /^- id: s1$/m)
    assert.match(text, /^- status: running$/m)
  })

  test('session_get requires a session id', async () => {
    assert.equal(await runGet({}), 'session-hub: session_id is required')
  })
})
