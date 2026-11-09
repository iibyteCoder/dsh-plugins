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
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../lib/index.js'
import { ownerIndexPath, readOwnerIndex, recordOwner } from '../lib/owner-index.js'
import { createSessionCreateTool } from '../lib/tools/create.js'
import { createManageTools } from '../lib/tools/manage.js'
import { createReadTools } from '../lib/tools/read.js'
import { createSendTools } from '../lib/tools/send.js'

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-hub-service-access-'))
process.env.DSH_HOME = tempHome

test.after(() => {
  fs.rmSync(tempHome, { recursive: true, force: true })
})

test.beforeEach(() => {
  fs.rmSync(ownerIndexPath(), { force: true })
})

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

/**
 * Build a context that behaves like the host proxy for the guarded services.
 *
 * `tools` stays readable because it is the one service the plugin declares in
 * `inject`; `get(name)` is the only way in for everything else.
 *
 * @param {Record<string, object>} services - Fake host services by name.
 * @returns {{ctx: object, registered: object[]}}
 */
function createHostContext(services) {
  const registered = []
  const target = { tools: { register: (tool) => registered.push(tool) } }

  const ctx = new Proxy(target, {
    get(inner, prop, receiver) {
      if (typeof prop === 'string' && GUARDED_SERVICES.includes(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      if (prop === 'get') {
        return (name) => services[name]
      }
      return Reflect.get(inner, prop, receiver)
    },
  })

  return { ctx, registered }
}

/**
 * Fake host services, recording every call the tools make.
 *
 * @param {{agent?: object} & Record<string, object>} [overrides]
 * @returns {{services: Record<string, object>, calls: object, agent: object}}
 */
function createHostServices({ agent: agentOverrides, ...overrides } = {}) {
  const calls = {
    create: [],
    rename: [],
    resolveAgent: [],
    inject: [],
    followup: [],
    steer: [],
    archiveSession: [],
    unarchiveSession: [],
  }
  const agent = {
    status: 'idle',
    inject: async (message) => {
      calls.inject.push(message)
    },
    followup: async (message) => {
      calls.followup.push(message)
    },
    steer: async (message) => {
      calls.steer.push(message)
    },
    ...agentOverrides,
  }
  const services = {
    sessionController: {
      list: async () => ({ items: [session] }),
      inspect: async (id) => {
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
      create: async (request) => {
        calls.create.push(request)
        return { sessionId: 'new-session' }
      },
      rename: async (request) => {
        calls.rename.push(request)
        return {}
      },
      selectModel: async () => ({}),
      modelCatalog: async () => ({ groups: [] }),
      resolveAgent: async (sessionId) => {
        calls.resolveAgent.push(sessionId)
        return { agent }
      },
      cancel: async () => ({}),
    },
    workspaceRegistry: { list: async () => [workspace], archivedSessionIds: [] },
    workspaceController: {
      archiveSession: async (request) => {
        calls.archiveSession.push(request)
        return {}
      },
      unarchiveSession: async (request) => {
        calls.unarchiveSession.push(request)
        return {}
      },
    },
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
    logger: { debug: () => {} },
    ...overrides,
  }
  return { services, calls, agent }
}

const exec = { agent: { id: callerId }, signal: undefined }

/**
 * @param {object[]} tools
 * @param {string} name
 * @returns {object}
 */
function toolByName(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name)
  assert.ok(tool !== undefined, `missing tool "${name}"`)
  return tool
}

/**
 * Every tool result in this file must be free of the inject failure; the
 * per-test assertions below only add the successful outcome on top.
 *
 * @param {unknown} text
 * @returns {string}
 */
function assertNoInjectFailure(text) {
  assert.equal(typeof text, 'string')
  assert.doesNotMatch(text, /without inject/)
  return text
}

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
    await toolByName(createReadTools(ctx), 'session_list').execute({}, exec),
  )

  assert.match(text, /^ID\s+TITLE\s+WORKSPACE\s+CWD\s+STATUS\s+MODEL\s+OWNER\s+UPDATED/)
  assert.match(text, /s1\s+Host session\s+Workspace One/)
  assert.match(text, /共 1 个会话（显示 1 个）$/)
})

test('session_get renders the session through ctx.get', async () => {
  const { services } = createHostServices()
  const { ctx } = createHostContext(services)

  const text = assertNoInjectFailure(
    await toolByName(createReadTools(ctx), 'session_get').execute({ session_id: 's1' }, exec),
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
    await toolByName([createSessionCreateTool(ctx)], 'session_create').execute(
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
  assert.equal(owners['new-session'].ownerSessionId, callerId)
  assert.equal(typeof owners['new-session'].createdAt, 'number')
})

test('session_close archives the session through ctx.get', async () => {
  await recordOwner('target', callerId)
  const { services, calls } = createHostServices()
  const { ctx } = createHostContext(services)

  const text = assertNoInjectFailure(
    await toolByName(createManageTools(ctx), 'session_close').execute({ session_id: 'target' }, exec),
  )

  assert.deepEqual(calls.archiveSession, [{ sessionId: 'target', stopActivity: true }])
  assert.match(text, /^已关闭会话 target/m)
})

test('session_send injects the message through ctx.get', async () => {
  await recordOwner('target', callerId)
  const { services, calls } = createHostServices()
  const { ctx } = createHostContext(services)

  const text = assertNoInjectFailure(
    await toolByName(createSendTools(ctx), 'session_send').execute(
      { session_id: 'target', message: 'hello there' },
      exec,
    ),
  )

  assert.deepEqual(calls.resolveAgent, ['target'])
  assert.equal(calls.inject.length, 1)
  assert.equal(calls.followup.length, 0)
  assert.equal(calls.steer.length, 0)
  assert.equal(calls.inject[0].role, 'user')
  assert.deepEqual(calls.inject[0].content, [
    { type: 'text', text: `Agent ${callerId} sent a message:\n\nhello there` },
  ])
  assert.equal(calls.inject[0].source.senderSessionId, callerId)
  assert.match(text, /已向会话 target 投递消息（不唤醒）/)
})

test('session_wake steers the running agent through ctx.get', async () => {
  await recordOwner('target', callerId)
  const { services, calls } = createHostServices({ agent: { status: 'running' } })
  const { ctx } = createHostContext(services)

  const text = assertNoInjectFailure(
    await toolByName(createSendTools(ctx), 'session_wake').execute(
      { session_id: 'target', message: 'hurry' },
      exec,
    ),
  )

  assert.equal(calls.steer.length, 1)
  assert.equal(calls.followup.length, 0)
  assert.match(text, /已请求会话 target 处理消息（running → steer）/)
})

test('session_wait reads the live snapshot through ctx.get', async () => {
  const waitAgent = { status: 'idle', whenIdle: async () => {} }
  const { services } = createHostServices({
    agents: { get: (sessionId) => (sessionId === 'target' ? waitAgent : undefined) },
    sessions: {
      get: (sessionId) => (sessionId === 'target' ? { snapshotEvents: () => [reply] } : undefined),
    },
  })
  const { ctx } = createHostContext(services)

  const text = assertNoInjectFailure(
    await toolByName(createSendTools(ctx), 'session_wait').execute(
      { session_id: 'target', timeout_ms: 1000 },
      exec,
    ),
  )

  assert.match(text, /^会话 target 已空闲$/m)
  assert.match(text, /- reply: on it$/)
})
