/**
 * Regression guard for the `without inject` runtime failure.
 *
 * A Cordis context is a proxy: reading a host service that the plugin did not
 * declare in `inject` throws `cannot get property "..." without inject`. This
 * file builds exactly such a proxy — every host service read raises unless it
 * goes through `ctx.get(name)` — and drives the real tools through it, so a
 * reintroduced `ctx.sessionController`-style read fails here instead of in the
 * running application.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { apply } from '../src/index.js'
import { ownerIndexPath, readOwnerIndex, recordOwner } from '../src/host/owner-index.js'
import { createSessionCreateTool } from '../src/tools/create.js'
import { createManageTools } from '../src/tools/manage.js'
import { createReadTools } from '../src/tools/read.js'
import { createSendTools } from '../src/tools/send.js'
import type { AgentMessage, HostContext } from '../src/shared/types.js'
import {
  createTempHome,
  executeTool,
  removeTempHome,
  toolByName,
  type FakeExec,
} from './helpers/fixtures.js'

const callerId = 'caller'
const rootDir = path.resolve('/fixtures/hub')
const createdAt = Date.UTC(2026, 0, 2, 3, 4)
const session = {
  sessionId: 's1',
  cwd: rootDir,
  running: true,
  updatedAt: createdAt,
  projections: { values: { title: 'Host session', modelSelection: { model: 'model-a' } } },
}
const workspace = { id: 'ws-alpha', title: 'Workspace One', path: rootDir, sessionIds: ['s1'] }
const reply = {
  type: 'assistant/message',
  data: { content: [{ type: 'text', text: 'on it' }] },
}

/**
 * Host services that are not declared in the plugin's `inject` and therefore
 * must never be read as context properties.
 */
const GUARDED_SERVICES = [
  'sessionController',
  'workspaceRegistry',
  'workspaceController',
  'sessions',
  'agents',
  'logger',
]

interface FakeAgentOverrides {
  readonly status?: string
  readonly inject?: (message: AgentMessage) => Promise<unknown>
  readonly followup?: (message: AgentMessage) => Promise<unknown>
  readonly steer?: (message: AgentMessage) => Promise<unknown>
}

interface HostServiceOverrides {
  readonly agent?: FakeAgentOverrides
  readonly agents?: { readonly get: (sessionId: string) => unknown }
  readonly sessions?: { readonly get: (sessionId: string) => unknown }
}

interface HostCalls {
  create: unknown[]
  rename: unknown[]
  resolveAgent: string[]
  inject: AgentMessage[]
  followup: AgentMessage[]
  steer: AgentMessage[]
  archiveSession: unknown[]
  unarchiveSession: unknown[]
}

/**
 * Build a context that behaves like the host proxy for the guarded services.
 *
 * `tools` stays readable because it is the one service the plugin declares in
 * `inject`; `get(name)` is the only way in for everything else.
 */
function createHostContext(services: Record<string, unknown>): {
  readonly ctx: Context
  readonly registered: ToolDefinition[]
} {
  const registered: ToolDefinition[] = []
  const target = {
    tools: {
      register: (tool: ToolDefinition): (() => void) => {
        registered.push(tool)
        return () => {}
      },
    },
  }

  const ctx = new Proxy(target, {
    get(inner, prop, receiver) {
      if (typeof prop === 'string' && GUARDED_SERVICES.includes(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      if (prop === 'get') {
        return (name: string): unknown => services[name]
      }
      return Reflect.get(inner, prop, receiver)
    },
  })

  return { ctx: ctx as unknown as Context, registered }
}

/** Fake host services, recording every call the tools make. */
function createHostServices(overrides: HostServiceOverrides = {}): {
  services: Record<string, unknown>
  calls: HostCalls
  agent: FakeAgentOverrides
} {
  const calls: HostCalls = {
    create: [],
    rename: [],
    resolveAgent: [],
    inject: [],
    followup: [],
    steer: [],
    archiveSession: [],
    unarchiveSession: [],
  }
  const agentOverrides = overrides.agent ?? {}
  const agent = {
    status: agentOverrides.status ?? 'idle',
    inject:
      agentOverrides.inject ??
      (async (message: AgentMessage): Promise<void> => {
        calls.inject.push(message)
      }),
    followup:
      agentOverrides.followup ??
      (async (message: AgentMessage): Promise<void> => {
        calls.followup.push(message)
      }),
    steer:
      agentOverrides.steer ??
      (async (message: AgentMessage): Promise<void> => {
        calls.steer.push(message)
      }),
  }
  const services: Record<string, unknown> = {
    sessionController: {
      list: async () => ({ items: [session] }),
      inspect: async (id: string) => {
        if (id !== 's1') throw new Error(`session ${id} not found`)
        return {
          meta: {
            id: 's1',
            createdAt,
            cwd: rootDir,
            parentSession: 's0',
            origin: 'cli',
            agentPreset: 'default',
          },
          inheritedEventCount: 0,
          events: [],
        }
      },
      create: async (request: unknown) => {
        calls.create.push(request)
        return { sessionId: 'new-session' }
      },
      rename: async (request: unknown) => {
        calls.rename.push(request)
        return {}
      },
      selectModel: async () => ({}),
      modelCatalog: async () => ({ groups: [] }),
      resolveAgent: async (sessionId: string) => {
        calls.resolveAgent.push(sessionId)
        return { agent }
      },
      cancel: async () => ({}),
    },
    workspaceRegistry: { list: async () => [workspace], archivedSessionIds: [] },
    workspaceController: {
      archiveSession: async (request: unknown) => {
        calls.archiveSession.push(request)
        return {}
      },
      unarchiveSession: async (request: unknown) => {
        calls.unarchiveSession.push(request)
        return {}
      },
    },
    sessions: overrides.sessions ?? { get: () => undefined },
    agents: overrides.agents ?? { get: () => undefined },
    logger: { debug: () => {} },
  }
  return { services, calls, agent }
}

const exec: FakeExec = { agent: { id: callerId }, signal: undefined }

/** Every tool result in this file must be free of the inject failure. */
function assertNoInjectFailure(text: string): string {
  assert.equal(typeof text, 'string')
  assert.doesNotMatch(text, /without inject/)
  return text
}

describe('host service access', () => {
  const tempHome = createTempHome('session-hub-service-access-')

  beforeEach(() => {
    process.env.DSH_HOME = tempHome
    fs.rmSync(ownerIndexPath(), { force: true })
  })

  after(() => {
    removeTempHome(tempHome)
  })

  test('apply mounts every tool on a proxy context that guards host services', () => {
    const { services } = createHostServices()
    const { ctx, registered } = createHostContext(services)

    assert.doesNotThrow(() => apply(ctx))

    assert.deepEqual(
      registered.map((tool) => tool.name),
      [
        'session_list',
        'session_get',
        'session_create',
        'session_update',
        'session_close',
        'session_open',
        'session_send',
        'session_wake',
        'session_wait',
      ],
    )
  })

  test('session_list renders the table through ctx.get', async () => {
    const { services } = createHostServices()
    const { ctx } = createHostContext(services)

    const text = assertNoInjectFailure(
      await executeTool(toolByName(createReadTools(ctx as unknown as HostContext), 'session_list'), {}, exec),
    )

    assert.match(text, /^ID\s+TITLE\s+WORKSPACE\s+CWD\s+STATUS\s+MODEL\s+OWNER\s+UPDATED/)
    assert.match(text, /s1\s+Host session\s+Workspace One/)
    assert.match(text, /共 1 个会话（显示 1 个）$/)
  })

  test('session_get renders the session through ctx.get', async () => {
    const { services } = createHostServices()
    const { ctx } = createHostContext(services)

    const text = assertNoInjectFailure(
      await executeTool(
        toolByName(createReadTools(ctx as unknown as HostContext), 'session_get'),
        { session_id: 's1' },
        exec,
      ),
    )

    assert.ok(text.startsWith('会话 s1\n'))
    assert.match(text, /^- id: s1$/m)
    assert.match(text, /^- cwd: /m)
    assert.match(text, /^- status: running$/m)
  })

  test('session_create resolves the workspace and records the owner through ctx.get', async () => {
    const { services, calls } = createHostServices()
    const { ctx } = createHostContext(services)

    const text = assertNoInjectFailure(
      await executeTool(
        createSessionCreateTool(ctx as unknown as HostContext),
        { workspace: 'Workspace One', message: 'build it' },
        exec,
      ),
    )

    assert.deepEqual(calls.create, [{ workspaceId: 'ws-alpha' }])
    assert.equal(calls.followup.length, 1)
    assert.match(text, /^已创建会话 new-session$/m)
    assert.match(text, /^- workspace: Workspace One$/m)
    assert.match(text, /^- owner: self$/m)
    assert.match(text, /^- started: 已投递初始任务$/m)

    const owners = await readOwnerIndex()
    assert.equal(owners['new-session']?.ownerSessionId, callerId)
    assert.equal(typeof owners['new-session']?.createdAt, 'number')
  })

  test('session_close archives the session through ctx.get', async () => {
    await recordOwner('target', callerId)
    const { services, calls } = createHostServices()
    const { ctx } = createHostContext(services)

    const text = assertNoInjectFailure(
      await executeTool(
        toolByName(createManageTools(ctx as unknown as HostContext), 'session_close'),
        { session_id: 'target' },
        exec,
      ),
    )

    assert.deepEqual(calls.archiveSession, [{ sessionId: 'target', stopActivity: true }])
    assert.match(text, /^已关闭会话 target/m)
  })

  test('session_send injects the message through ctx.get', async () => {
    await recordOwner('target', callerId)
    const { services, calls } = createHostServices()
    const { ctx } = createHostContext(services)

    const text = assertNoInjectFailure(
      await executeTool(
        toolByName(createSendTools(ctx as unknown as HostContext), 'session_send'),
        { session_id: 'target', message: 'hello there' },
        exec,
      ),
    )

    assert.deepEqual(calls.resolveAgent, ['target'])
    assert.equal(calls.inject.length, 1)
    assert.equal(calls.followup.length, 0)
    assert.equal(calls.steer.length, 0)
    assert.equal(calls.inject[0]?.role, 'user')
    assert.deepEqual(calls.inject[0]?.content, [
      { type: 'text', text: `Agent ${callerId} sent a message:\n\nhello there` },
    ])
    assert.equal(calls.inject[0]?.source.senderSessionId, callerId)
    assert.match(text, /已向会话 target 投递消息（不唤醒）/)
  })

  test('session_wake steers the running agent through ctx.get', async () => {
    await recordOwner('target', callerId)
    const { services, calls } = createHostServices({ agent: { status: 'running' } })
    const { ctx } = createHostContext(services)

    const text = assertNoInjectFailure(
      await executeTool(
        toolByName(createSendTools(ctx as unknown as HostContext), 'session_wake'),
        { session_id: 'target', message: 'hurry' },
        exec,
      ),
    )

    assert.equal(calls.steer.length, 1)
    assert.equal(calls.followup.length, 0)
    assert.match(text, /已请求会话 target 处理消息（running → steer）/)
  })

  test('session_wait reads the live snapshot through ctx.get', async () => {
    const waitAgent = { status: 'idle', whenIdle: async (): Promise<void> => {} }
    const { services } = createHostServices({
      agents: { get: (sessionId: string) => (sessionId === 'target' ? waitAgent : undefined) },
      sessions: {
        get: (sessionId: string) =>
          sessionId === 'target' ? { snapshotEvents: () => [reply] } : undefined,
      },
    })
    const { ctx } = createHostContext(services)

    const text = assertNoInjectFailure(
      await executeTool(
        toolByName(createSendTools(ctx as unknown as HostContext), 'session_wait'),
        { session_id: 'target', timeout_ms: 1000 },
        exec,
      ),
    )

    assert.match(text, /^会话 target 已空闲$/m)
    assert.match(text, /- reply: on it$/)
  })
})
