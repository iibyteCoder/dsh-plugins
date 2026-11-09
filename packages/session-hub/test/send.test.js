import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { sendToSession } from '../lib/messaging.js'
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

function createCtx({ agent: agentOverrides, ...overrides } = {}) {
  const calls = { followup: [], steer: [], cancel: [], resolveAgent: [], inspect: [] }
  const agent = {
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
      cancel: async (request) => {
        calls.cancel.push(request)
        return { accepted: true }
      },
    },
    workspaceRegistry: { archivedSessionIds: [] },
    ...overrides,
    // The host resolves services through `ctx.get(name)`, never through plain
    // property reads; mirror that so these fixtures keep the host contract.
    get(name) {
      return this[name]
    },
  }
  return { ctx, calls, agent }
}

function toolByName(ctx, toolName) {
  const tool = createSendTools(ctx).find((candidate) => candidate.name === toolName)
  assert.ok(tool !== undefined, `missing tool "${toolName}"`)
  return tool
}

function runSend(args, ctx, exec = { agent: { id: callerId } }) {
  return toolByName(ctx, 'session_send').execute(args, exec)
}

function runInterrupt(args, ctx, exec = { agent: { id: callerId } }) {
  return toolByName(ctx, 'session_interrupt').execute(args, exec)
}

function assistantMessage(text) {
  return { type: 'assistant/message', data: { content: [{ type: 'text', text }] } }
}

const confirmErrorText = (sessionId) =>
  `session-hub: CONFIRM_REQUIRED: session "${sessionId}" is not owned by the calling session`

const waitTimeoutText =
  'session-hub: WAIT_TIMEOUT: message delivered but the session did not become idle'

// --- session_send ---------------------------------------------------------

test('session_send queues a message attributed to the caller', async () => {
  await recordOwner('target', callerId)
  const { ctx, calls } = createCtx()

  const text = await runSend({ session_id: 'target', message: 'hello there' }, ctx)

  assert.equal(text, '已向会话 target 发送消息（mode=queue）')
  assert.deepEqual(calls.resolveAgent, ['target'])
  assert.equal(calls.followup.length, 1)
  assert.equal(calls.steer.length, 0)

  const message = calls.followup[0]
  assert.equal(message.role, 'user')
  assert.deepEqual(message.content, [
    { type: 'text', text: `Agent ${callerId} sent a message:\n\nhello there` },
  ])
  assert.equal(message.source.kind, 'agent-message')
  assert.equal(message.source.form, 'relay')
  assert.equal(message.source.senderSessionId, callerId)
  assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})

test('session_send steers instead of queueing when mode is steer', async () => {
  await recordOwner('target', callerId)
  const { ctx, calls } = createCtx()

  const text = await runSend(
    { session_id: 'target', message: 'hurry', mode: 'steer' },
    ctx,
  )

  assert.equal(calls.followup.length, 0)
  assert.equal(calls.steer.length, 1)
  assert.equal(calls.steer[0].content[0].text, `Agent ${callerId} sent a message:\n\nhurry`)
  assert.equal(text, '已向会话 target 发送消息（mode=steer）')
})

test('session_send refuses to send to the calling session', async () => {
  const { ctx, calls } = createCtx()

  const text = await runSend({ session_id: callerId, message: 'loop' }, ctx)

  assert.equal(text, 'session-hub: SELF_TARGET: a session cannot send a message to itself')
  assert.deepEqual(calls.resolveAgent, [])
  assert.deepEqual(calls.followup, [])
})

test('session_send rejects a non-owner without confirmation and never resolves the agent', async () => {
  await recordOwner('target', 'other')
  const { ctx, calls } = createCtx()

  const text = await runSend({ session_id: 'target', message: 'hello' }, ctx)

  assert.equal(text, confirmErrorText('target'))
  assert.deepEqual(calls.resolveAgent, [])
  assert.deepEqual(calls.followup, [])
})

test('session_send does not accept the string "true" as confirmation', async () => {
  await recordOwner('target', 'other')
  const { ctx, calls } = createCtx()

  const text = await runSend(
    { session_id: 'target', message: 'hello', confirm: 'true' },
    ctx,
  )

  assert.equal(text, confirmErrorText('target'))
  assert.deepEqual(calls.resolveAgent, [])
})

test('session_send allows a non-owner with confirm: true', async () => {
  await recordOwner('target', 'other')
  const { ctx, calls } = createCtx()

  const text = await runSend(
    { session_id: 'target', message: 'hello', confirm: true },
    ctx,
  )

  assert.deepEqual(calls.resolveAgent, ['target'])
  assert.equal(calls.followup.length, 1)
  assert.equal(text, '已向会话 target 发送消息（mode=queue）')
})

test('session_send refuses an archived session', async () => {
  await recordOwner('target', callerId)
  const { ctx, calls } = createCtx()
  ctx.workspaceRegistry.archivedSessionIds = ['target', 'other-archived']

  const text = await runSend({ session_id: 'target', message: 'hello' }, ctx)

  assert.equal(
    text,
    'session-hub: SESSION_ARCHIVED: session "target" is archived; call session_open first',
  )
  assert.deepEqual(calls.resolveAgent, [])
})

test('session_send checks ownership before the archive gate', async () => {
  await recordOwner('target', 'other')
  const { ctx, calls } = createCtx()
  ctx.workspaceRegistry.archivedSessionIds = ['target']

  const text = await runSend({ session_id: 'target', message: 'hello' }, ctx)

  assert.equal(text, confirmErrorText('target'))
  assert.deepEqual(calls.resolveAgent, [])
})

test('session_send falls back to inspect when the session is not live', async () => {
  await recordOwner('target', callerId)
  const { ctx, calls } = createCtx({ agent: { whenIdle: async () => {} } })
  ctx.sessionController.inspect = async (sessionId) => {
    calls.inspect.push(sessionId)
    return { events: [assistantMessage('reply from inspect')] }
  }

  const text = await runSend({ session_id: 'target', message: 'hello', wait: true }, ctx)

  assert.deepEqual(calls.inspect, ['target'])
  assert.equal(
    text,
    '已向会话 target 发送消息（mode=queue）\n- reply: reply from inspect',
  )
})

test('session_send waits for idle and returns the latest assistant reply', async () => {
  await recordOwner('target', callerId)
  let idleWaited = 0
  const { ctx, calls } = createCtx({
    agent: {
      whenIdle: async () => {
        idleWaited += 1
      },
    },
  })
  ctx.sessions = {
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
  }

  const text = await runSend({ session_id: 'target', message: 'hello', wait: true }, ctx)

  assert.equal(calls.followup.length, 1)
  assert.equal(idleWaited, 1)
  assert.equal(
    text,
    '已向会话 target 发送消息（mode=queue）\n- reply: latest answer',
  )
})

test('session_send truncates a very long reply', async () => {
  const longReply = 'x'.repeat(2500)
  const { ctx } = createCtx({ agent: { whenIdle: async () => {} } })
  ctx.sessions = {
    get: () => ({ snapshotEvents: () => [assistantMessage(longReply)] }),
  }

  const result = await sendToSession(ctx, {
    sessionId: 'target',
    text: 'hello',
    wait: true,
    senderId: callerId,
  })

  assert.equal(result.ok, true)
  const reply = result.text.slice(result.text.indexOf('- reply: ') + '- reply: '.length)
  assert.ok(Array.from(reply).length <= 2001, `reply was ${Array.from(reply).length} chars`)
  assert.ok(reply.endsWith('…'))
})

test('session_send reports WAIT_TIMEOUT without waiting for the default timeout', async () => {
  await recordOwner('target', callerId)
  const { ctx, calls } = createCtx({ agent: { whenIdle: () => new Promise(() => {}) } })

  const startedAt = Date.now()
  const text = await runSend(
    { session_id: 'target', message: 'hello', wait: true, timeout_ms: 1000 },
    ctx,
  )
  const elapsed = Date.now() - startedAt

  assert.equal(text, waitTimeoutText)
  assert.equal(calls.followup.length, 1)
  assert.ok(elapsed >= 900, `expected the 1000 ms timeout, got ${elapsed} ms`)
  assert.ok(elapsed < 5000, `expected a bounded wait, got ${elapsed} ms`)
})

test('session_send reports resolveAgent errors by code', async () => {
  await recordOwner('target', callerId)
  const { ctx, calls } = createCtx()
  ctx.sessionController.resolveAgent = async () => ({
    error: { code: 'session/not-found', message: 'gone' },
  })

  const text = await runSend({ session_id: 'target', message: 'hello' }, ctx)

  assert.equal(text, 'session-hub: send failed: session/not-found')
  assert.deepEqual(calls.followup, [])
})

test('session_send reports an unknown resolveAgent error code', async () => {
  await recordOwner('target', callerId)
  const { ctx } = createCtx()
  ctx.sessionController.resolveAgent = async () => ({ error: {} })

  const text = await runSend({ session_id: 'target', message: 'hello' }, ctx)

  assert.equal(text, 'session-hub: send failed: unknown')
})

test('session_send reports delivery failures', async () => {
  await recordOwner('target', callerId)
  const { ctx } = createCtx({
    agent: {
      followup: async () => {
        throw new Error('busy')
      },
    },
  })

  const text = await runSend({ session_id: 'target', message: 'hello' }, ctx)

  assert.equal(text, 'session-hub: send failed: busy')
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

test('sendToSession omits the sender claim when the caller id is unknown', async () => {
  const { ctx, calls } = createCtx()

  const result = await sendToSession(ctx, { sessionId: 'target', text: 'hello' })

  assert.equal(result.ok, true)
  assert.deepEqual(calls.followup[0].content, [{ type: 'text', text: 'hello' }])
  assert.equal('senderSessionId' in calls.followup[0].source, false)
})

test('sendToSession reports a missing sessionController', async () => {
  await assert.rejects(
    sendToSession({}, { sessionId: 'target', text: 'hello' }),
    /session-hub: sessionController service is unavailable in this profile/,
  )
})

// --- session_interrupt ----------------------------------------------------

test('session_interrupt cancels the target session', async () => {
  await recordOwner('target', callerId)
  const { ctx, calls } = createCtx()

  const text = await runInterrupt({ session_id: 'target' }, ctx)

  assert.deepEqual(calls.cancel, [{ sessionId: 'target' }])
  assert.equal(text, '已打断会话 target')
})

test('session_interrupt rejects a non-owner without confirmation and cancels nothing', async () => {
  await recordOwner('target', 'other')
  const { ctx, calls } = createCtx()

  const text = await runInterrupt({ session_id: 'target' }, ctx)

  assert.equal(text, confirmErrorText('target'))
  assert.deepEqual(calls.cancel, [])
})

test('session_interrupt allows a non-owner with confirm: true', async () => {
  await recordOwner('target', 'other')
  const { ctx, calls } = createCtx()

  const text = await runInterrupt({ session_id: 'target', confirm: true }, ctx)

  assert.deepEqual(calls.cancel, [{ sessionId: 'target' }])
  assert.equal(text, '已打断会话 target')
})

test('session_interrupt wraps cancel failures', async () => {
  await recordOwner('target', callerId)
  const { ctx } = createCtx()
  ctx.sessionController.cancel = async () => {
    throw new Error('boom')
  }

  const text = await runInterrupt({ session_id: 'target' }, ctx)

  assert.equal(text, 'session-hub: interrupt failed: boom')
})

test('session_interrupt requires a session id', async () => {
  const { ctx, calls } = createCtx()

  const text = await runInterrupt({}, ctx)

  assert.equal(text, 'session-hub: session_id is required')
  assert.deepEqual(calls.cancel, [])
})

// --- schemas --------------------------------------------------------------

test('send tool schemas stay within the supported keyword subset', () => {
  const { ctx } = createCtx()

  for (const tool of createSendTools(ctx)) {
    assertSupportedSchema(tool.parameters, `${tool.name}.parameters`)
    assertSupportedSchema(tool.output.schema, `${tool.name}.output.schema`)
    for (const [name, schema] of Object.entries(tool.parameters.properties)) {
      assert.equal('minimum' in schema, false, `${tool.name}.${name}: "minimum" is not supported`)
      assert.equal('maximum' in schema, false, `${tool.name}.${name}: "maximum" is not supported`)
    }
  }
})
