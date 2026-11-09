import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildAgentMessage, clampTimeout, deliver, waitForIdle } from '../lib/messaging.js'
import { ownerIndexPath, recordOwner } from '../lib/owner-index.js'
import { createSendTools } from '../lib/tools/send.js'
import { assertSupportedSchema } from './helpers/schema-guard.js'

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-hub-send-'))
process.env.DSH_HOME = tempHome

test.after(() => {
  fs.rmSync(tempHome, { recursive: true, force: true })
})

test.beforeEach(() => {
  fs.rmSync(ownerIndexPath(), { force: true })
})

const callerId = 'caller'
const defaultExec = { agent: { id: callerId } }

function createCtx({ agent: agentOverrides, agents, sessions, workspaceRegistry, ...overrides } = {}) {
  const calls = { inject: [], followup: [], steer: [], resolveAgent: [], inspect: [] }
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
  const ctx = {
    sessionController: {
      resolveAgent: async (sessionId) => {
        calls.resolveAgent.push(sessionId)
        return { agent }
      },
      inspect: async (sessionId) => {
        calls.inspect.push(sessionId)
        return { events: [] }
      },
    },
    workspaceRegistry: workspaceRegistry ?? { archivedSessionIds: [] },
    agents: agents ?? { get: () => undefined },
    ...(sessions === undefined ? {} : { sessions }),
    ...overrides,
    // The host resolves services through `ctx.get(name)`, never through plain
    // property reads; mirror that so these fixtures keep the host contract.
    get(name) {
      return this[name]
    },
  }
  return { ctx, calls, agent }
}

function toolByName(ctx, toolName, permissionMode = 'permissive') {
  const tool = createSendTools(ctx, { permissionMode }).find((candidate) => candidate.name === toolName)
  assert.ok(tool !== undefined, `missing tool "${toolName}"`)
  return tool
}

function runSend(args, ctx, permissionMode = 'permissive', exec = defaultExec) {
  return toolByName(ctx, 'session_send', permissionMode).execute(args, exec)
}

function runWake(args, ctx, permissionMode = 'permissive', exec = defaultExec) {
  return toolByName(ctx, 'session_wake', permissionMode).execute(args, exec)
}

function runWait(args, ctx, exec = defaultExec) {
  return toolByName(ctx, 'session_wait').execute(args, exec)
}

function assistantMessage(text) {
  return { type: 'assistant/message', data: { content: [{ type: 'text', text }] } }
}

const confirmErrorText = (sessionId) =>
  `session-hub: CONFIRM_REQUIRED: session "${sessionId}" is not owned by the calling session`

const selfTargetText = 'session-hub: SELF_TARGET: a session cannot send a message to itself'

const archivedText = (sessionId) =>
  `session-hub: SESSION_ARCHIVED: session "${sessionId}" is archived; call session_open first`

// --- message construction -------------------------------------------------

test('buildAgentMessage attributes a known sender in body and source', () => {
  const message = buildAgentMessage('hello there', callerId)

  assert.equal(message.role, 'user')
  assert.deepEqual(message.content, [
    { type: 'text', text: `Agent ${callerId} sent a message:\n\nhello there` },
  ])
  assert.deepEqual(message.source, {
    kind: 'agent-message',
    form: 'relay',
    senderSessionId: callerId,
  })
  assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})

test('buildAgentMessage omits the sender claim when the sender is unknown', () => {
  const message = buildAgentMessage('hello', '')

  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }])
  assert.equal('senderSessionId' in message.source, false)
  assert.deepEqual(message.source, { kind: 'agent-message', form: 'relay' })
})

test('buildAgentMessage trims a whitespace-only sender away', () => {
  const message = buildAgentMessage('hello', '   ')

  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }])
  assert.equal('senderSessionId' in message.source, false)
})

// --- session_send ---------------------------------------------------------

test('session_send only injects the message and does not wake the target', async () => {
  await recordOwner('target', callerId)
  const { ctx, calls } = createCtx()

  const text = await runSend({ session_id: 'target', message: 'hello there' }, ctx)

  assert.equal(text, '已向会话 target 投递消息（不唤醒）')
  assert.deepEqual(calls.resolveAgent, ['target'])
  assert.equal(calls.inject.length, 1)
  assert.equal(calls.followup.length, 0)
  assert.equal(calls.steer.length, 0)

  const message = calls.inject[0]
  assert.equal(message.role, 'user')
  assert.deepEqual(message.content, [
    { type: 'text', text: `Agent ${callerId} sent a message:\n\nhello there` },
  ])
  assert.equal(message.source.kind, 'agent-message')
  assert.equal(message.source.form, 'relay')
  assert.equal(message.source.senderSessionId, callerId)
})

test('session_send never queues or steers even when the target is running', async () => {
  await recordOwner('target', callerId)
  const { ctx, calls } = createCtx({ agent: { status: 'running' } })

  const text = await runSend({ session_id: 'target', message: 'hello' }, ctx)

  assert.equal(calls.inject.length, 1)
  assert.equal(calls.followup.length, 0)
  assert.equal(calls.steer.length, 0)
  assert.equal(text, '已向会话 target 投递消息（不唤醒）')
})

test('session_send omits the sender claim when the caller id is unknown', async () => {
  const { ctx, calls } = createCtx()

  const result = await deliver(ctx, { sessionId: 'target', text: 'hello' })

  assert.equal(result.ok, true)
  assert.deepEqual(calls.inject[0].content, [{ type: 'text', text: 'hello' }])
  assert.equal('senderSessionId' in calls.inject[0].source, false)
})

test('session_send refuses to send to the calling session', async () => {
  const { ctx, calls } = createCtx()

  const text = await runSend({ session_id: callerId, message: 'loop' }, ctx)

  assert.equal(text, selfTargetText)
  assert.deepEqual(calls.resolveAgent, [])
  assert.deepEqual(calls.inject, [])
})

test('session_send requires a session id and a message', async () => {
  const { ctx, calls } = createCtx()

  assert.equal(await runSend({ message: 'hello' }, ctx), 'session-hub: session_id is required')
  assert.equal(
    await runSend({ session_id: 'target', message: '   ' }, ctx),
    'session-hub: message is required',
  )
  assert.deepEqual(calls.resolveAgent, [])
})

test('session_send in owned mode rejects a non-owner without confirmation', async () => {
  await recordOwner('target', 'other')
  const { ctx, calls } = createCtx()

  const text = await runSend({ session_id: 'target', message: 'hello' }, ctx, 'owned')

  assert.equal(text, confirmErrorText('target'))
  assert.deepEqual(calls.resolveAgent, [])
})

test('session_send in owned mode does not accept the string "true" as confirmation', async () => {
  await recordOwner('target', 'other')
  const { ctx, calls } = createCtx()

  const text = await runSend({ session_id: 'target', message: 'hello', confirm: 'true' }, ctx, 'owned')

  assert.equal(text, confirmErrorText('target'))
  assert.deepEqual(calls.resolveAgent, [])
})

test('session_send in owned mode allows a non-owner with confirm: true', async () => {
  await recordOwner('target', 'other')
  const { ctx, calls } = createCtx()

  const text = await runSend({ session_id: 'target', message: 'hello', confirm: true }, ctx, 'owned')

  assert.deepEqual(calls.resolveAgent, ['target'])
  assert.equal(calls.inject.length, 1)
  assert.equal(text, '已向会话 target 投递消息（不唤醒）')
})

test('session_send in permissive mode sends to a session created by another session', async () => {
  await recordOwner('target', 'other')
  const { ctx, calls } = createCtx()

  const text = await runSend({ session_id: 'target', message: 'hello' }, ctx)

  assert.deepEqual(calls.resolveAgent, ['target'])
  assert.equal(calls.inject.length, 1)
  assert.equal(text, '已向会话 target 投递消息（不唤醒）')
})

test('session_send refuses an archived session', async () => {
  await recordOwner('target', callerId)
  const { ctx, calls } = createCtx({ workspaceRegistry: { archivedSessionIds: ['target'] } })

  const text = await runSend({ session_id: 'target', message: 'hello' }, ctx)

  assert.equal(text, archivedText('target'))
  assert.deepEqual(calls.resolveAgent, [])
})

test('session_send checks ownership before the archive gate in owned mode', async () => {
  await recordOwner('target', 'other')
  const { ctx, calls } = createCtx({ workspaceRegistry: { archivedSessionIds: ['target'] } })

  const text = await runSend({ session_id: 'target', message: 'hello' }, ctx, 'owned')

  assert.equal(text, confirmErrorText('target'))
  assert.deepEqual(calls.resolveAgent, [])
})

test('session_send reports resolveAgent errors by code', async () => {
  await recordOwner('target', callerId)
  const { ctx } = createCtx()
  ctx.sessionController.resolveAgent = async () => ({
    error: { code: 'session/not-found', message: 'gone' },
  })

  const text = await runSend({ session_id: 'target', message: 'hello' }, ctx)

  assert.equal(text, 'session-hub: send failed: session/not-found')
})

test('session_send reports an unknown resolveAgent error code', async () => {
  await recordOwner('target', callerId)
  const { ctx } = createCtx()
  ctx.sessionController.resolveAgent = async () => ({ error: {} })

  const text = await runSend({ session_id: 'target', message: 'hello' }, ctx)

  assert.equal(text, 'session-hub: send failed: unknown')
})

test('session_send reports inject failures', async () => {
  await recordOwner('target', callerId)
  const { ctx } = createCtx({
    agent: {
      inject: async () => {
        throw new Error('busy')
      },
    },
  })

  const text = await runSend({ session_id: 'target', message: 'hello' }, ctx)

  assert.equal(text, 'session-hub: send failed: busy')
})

test('session_send reports a missing sessionController', async () => {
  const text = await runSend({ session_id: 'target', message: 'hello' }, {})

  assert.equal(text, 'session-hub: sessionController service is unavailable in this profile')
  await assert.rejects(
    deliver({}, { sessionId: 'target', text: 'hello' }),
    /session-hub: sessionController service is unavailable in this profile/,
  )
})

// --- session_wake ---------------------------------------------------------

test('session_wake follows up on an idle target', async () => {
  await recordOwner('target', callerId)
  const { ctx, calls } = createCtx({ agent: { status: 'idle' } })

  const text = await runWake({ session_id: 'target', message: 'hello there' }, ctx)

  assert.equal(text, '已请求会话 target 处理消息（idle → followup）')
  assert.deepEqual(calls.resolveAgent, ['target'])
  assert.equal(calls.followup.length, 1)
  assert.equal(calls.steer.length, 0)
  assert.equal(calls.inject.length, 0)

  const message = calls.followup[0]
  assert.equal(message.role, 'user')
  assert.deepEqual(message.content, [
    { type: 'text', text: `Agent ${callerId} sent a message:\n\nhello there` },
  ])
  assert.equal(message.source.senderSessionId, callerId)
})

test('session_wake follows up when the target status is unknown', async () => {
  const { ctx, calls } = createCtx({ agent: { status: undefined } })

  const text = await runWake({ session_id: 'target', message: 'hello' }, ctx)

  assert.equal(text, '已请求会话 target 处理消息（idle → followup）')
  assert.equal(calls.followup.length, 1)
})

test('session_wake steers a running target', async () => {
  await recordOwner('target', callerId)
  const { ctx, calls } = createCtx({ agent: { status: 'running' } })

  const text = await runWake({ session_id: 'target', message: 'hurry' }, ctx)

  assert.equal(text, '已请求会话 target 处理消息（running → steer）')
  assert.equal(calls.steer.length, 1)
  assert.equal(calls.followup.length, 0)
  assert.equal(calls.inject.length, 0)
  assert.deepEqual(calls.steer[0].content, [
    { type: 'text', text: `Agent ${callerId} sent a message:\n\nhurry` },
  ])
})

test('session_wake refuses to wake the calling session', async () => {
  const { ctx, calls } = createCtx()

  const text = await runWake({ session_id: callerId, message: 'loop' }, ctx)

  assert.equal(text, selfTargetText)
  assert.deepEqual(calls.resolveAgent, [])
  assert.deepEqual(calls.followup, [])
  assert.deepEqual(calls.steer, [])
})

test('session_wake requires a session id and a message', async () => {
  const { ctx, calls } = createCtx()

  assert.equal(await runWake({ message: 'hello' }, ctx), 'session-hub: session_id is required')
  assert.equal(
    await runWake({ session_id: 'target', message: '   ' }, ctx),
    'session-hub: message is required',
  )
  assert.deepEqual(calls.resolveAgent, [])
})

test('session_wake in owned mode rejects a non-owner without confirmation', async () => {
  await recordOwner('target', 'other')
  const { ctx, calls } = createCtx()

  const text = await runWake({ session_id: 'target', message: 'hello' }, ctx, 'owned')

  assert.equal(text, confirmErrorText('target'))
  assert.deepEqual(calls.resolveAgent, [])
  assert.deepEqual(calls.followup, [])
})

test('session_wake in owned mode allows a non-owner with confirm: true', async () => {
  await recordOwner('target', 'other')
  const { ctx, calls } = createCtx()

  const text = await runWake(
    { session_id: 'target', message: 'hello', confirm: true },
    ctx,
    'owned',
  )

  assert.equal(calls.followup.length, 1)
  assert.equal(text, '已请求会话 target 处理消息（idle → followup）')
})

test('session_wake refuses an archived session', async () => {
  await recordOwner('target', callerId)
  const { ctx, calls } = createCtx({ workspaceRegistry: { archivedSessionIds: ['target'] } })

  const text = await runWake({ session_id: 'target', message: 'hello' }, ctx)

  assert.equal(text, archivedText('target'))
  assert.deepEqual(calls.resolveAgent, [])
  assert.deepEqual(calls.followup, [])
})

test('session_wake reports resolveAgent errors by code', async () => {
  await recordOwner('target', callerId)
  const { ctx } = createCtx()
  ctx.sessionController.resolveAgent = async () => ({
    error: { code: 'session/not-found', message: 'gone' },
  })

  const text = await runWake({ session_id: 'target', message: 'hello' }, ctx)

  assert.equal(text, 'session-hub: send failed: session/not-found')
})

test('session_wake reports followup failures', async () => {
  await recordOwner('target', callerId)
  const { ctx } = createCtx({
    agent: {
      followup: async () => {
        throw new Error('busy')
      },
    },
  })

  const text = await runWake({ session_id: 'target', message: 'hello' }, ctx)

  assert.equal(text, 'session-hub: send failed: busy')
})

// --- session_wait ---------------------------------------------------------

test('session_wait returns the latest assistant reply from the live snapshot', async () => {
  let idleWaited = 0
  const { ctx } = createCtx({
    agents: { get: (sessionId) => (sessionId === 'target' ? { whenIdle: async () => { idleWaited += 1 } } : undefined) },
    sessions: {
      get: (sessionId) =>
        sessionId === 'target'
          ? {
              snapshotEvents: () => [
                { type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }] } },
                assistantMessage('first answer'),
                assistantMessage('latest answer'),
              ],
            }
          : undefined,
    },
  })

  const text = await runWait({ session_id: 'target' }, ctx)

  assert.equal(idleWaited, 1)
  assert.equal(text, '会话 target 已空闲\n- reply: latest answer')
})

test('session_wait falls back to inspect when the session is not live', async () => {
  const { ctx, calls } = createCtx({
    agents: { get: () => ({ whenIdle: async () => {} }) },
  })
  ctx.sessionController.inspect = async (sessionId) => {
    calls.inspect.push(sessionId)
    return { events: [assistantMessage('reply from inspect')] }
  }

  const text = await runWait({ session_id: 'target' }, ctx)

  assert.deepEqual(calls.inspect, ['target'])
  assert.equal(text, '会话 target 已空闲\n- reply: reply from inspect')
})

test('session_wait reports idle without a reply line when there is no assistant message', async () => {
  const { ctx } = createCtx({ agents: { get: () => ({ whenIdle: async () => {} }) } })

  const text = await runWait({ session_id: 'target' }, ctx)

  assert.equal(text, '会话 target 已空闲')
})

test('session_wait returns immediately for a cold session', async () => {
  const { ctx } = createCtx({ agents: { get: () => undefined } })

  const text = await runWait({ session_id: 'target' }, ctx)

  assert.equal(text, '会话 target 空闲（未加载）')
})

test('session_wait returns immediately for an archived session', async () => {
  const { ctx } = createCtx({
    agents: { get: () => ({ whenIdle: async () => {} }) },
    workspaceRegistry: { archivedSessionIds: ['target'] },
  })

  const text = await runWait({ session_id: 'target' }, ctx)

  assert.equal(text, '会话 target 已归档，不会运行')
})

test('session_wait does not require confirmation for a session created by another session', async () => {
  await recordOwner('target', 'other')
  const { ctx } = createCtx({ agents: { get: () => ({ whenIdle: async () => {} }) } })

  const text = await runWait({ session_id: 'target' }, ctx)

  assert.equal(text, '会话 target 已空闲')
})

test('session_wait reports WAIT_TIMEOUT with the clamped budget', async () => {
  const { ctx } = createCtx({ agents: { get: () => ({ whenIdle: () => new Promise(() => {}) }) } })

  const startedAt = Date.now()
  const text = await runWait({ session_id: 'target', timeout_ms: 1000 }, ctx)
  const elapsed = Date.now() - startedAt

  assert.equal(
    text,
    'session-hub: WAIT_TIMEOUT: session "target" did not become idle within 1000ms',
  )
  assert.ok(elapsed >= 900, `expected the 1000 ms timeout, got ${elapsed} ms`)
  assert.ok(elapsed < 5000, `expected a bounded wait, got ${elapsed} ms`)
})

test('session_wait truncates a very long reply', async () => {
  const longReply = 'x'.repeat(2500)
  const { ctx } = createCtx({
    agents: { get: () => ({ whenIdle: async () => {} }) },
    sessions: { get: () => ({ snapshotEvents: () => [assistantMessage(longReply)] }) },
  })

  const result = await waitForIdle(ctx, 'target')

  assert.equal(result.status, 'idle')
  assert.equal(Array.from(result.reply).length, 2001)
  assert.ok(result.reply.endsWith('…'))
})

test('session_wait requires a session id', async () => {
  const { ctx } = createCtx()

  assert.equal(await runWait({}, ctx), 'session-hub: session_id is required')
})

test('clampTimeout bounds the wait window', () => {
  assert.equal(clampTimeout(undefined), 120000)
  assert.equal(clampTimeout(1), 1000)
  assert.equal(clampTimeout(999999), 600000)
  assert.equal(clampTimeout('abc'), 120000)
  assert.equal(clampTimeout(5000.9), 5000)
})

// --- schemas --------------------------------------------------------------

test('messaging tool schemas stay within the supported keyword subset in both modes', () => {
  const { ctx } = createCtx()

  for (const permissionMode of ['permissive', 'owned']) {
    for (const tool of createSendTools(ctx, { permissionMode })) {
      const label = `${tool.name} (${permissionMode})`
      assertSupportedSchema(tool.parameters, `${label}.parameters`)
      assertSupportedSchema(tool.output.schema, `${label}.output.schema`)
      for (const [name, schema] of Object.entries(tool.parameters.properties)) {
        assert.equal('minimum' in schema, false, `${label}.${name}: "minimum" is not supported`)
        assert.equal('maximum' in schema, false, `${label}.${name}: "maximum" is not supported`)
      }
    }
  }
})

test('permissive messaging schemas omit confirm', () => {
  const { ctx } = createCtx()

  for (const toolName of ['session_send', 'session_wake', 'session_wait']) {
    const tool = toolByName(ctx, toolName, 'permissive')
    assert.equal('confirm' in tool.parameters.properties, false, `${toolName} must omit confirm`)
  }
})

test('owned send and wake schemas declare confirm, wait never does', () => {
  const { ctx } = createCtx()
  const send = toolByName(ctx, 'session_send', 'owned')
  const wake = toolByName(ctx, 'session_wake', 'owned')
  const wait = toolByName(ctx, 'session_wait', 'owned')

  assert.equal(send.parameters.properties.confirm.type, 'boolean')
  assert.equal(wake.parameters.properties.confirm.type, 'boolean')
  assert.equal('confirm' in wait.parameters.properties, false)
})

test('send and wake declare only a target and a message', () => {
  const { ctx } = createCtx()

  for (const toolName of ['session_send', 'session_wake']) {
    const tool = toolByName(ctx, toolName)
    assert.deepEqual(tool.parameters.required, ['session_id', 'message'])
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['message', 'session_id'])
  }
})

test('session_wait declares a session id and an integer timeout', () => {
  const tool = toolByName(createCtx().ctx, 'session_wait')

  assert.deepEqual(tool.parameters.required, ['session_id'])
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['session_id', 'timeout_ms'])
  assert.equal(tool.parameters.properties.timeout_ms.type, 'integer')
  assert.equal(tool.parameters.properties.timeout_ms.default, 120000)
})
