import assert from 'node:assert/strict'
import fs from 'node:fs'
import { after, beforeEach, describe, test } from 'node:test'

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { buildAgentMessage, clampTimeout, deliver } from '../src/domain/messaging.js'
import { ownerIndexPath, recordOwner } from '../src/host/owner-index.js'
import { createSendTools } from '../src/tools/send.js'
import { PermissionMode, SessionStatus } from '../src/shared/enums.js'
import type { AgentMessage, HostContext } from '../src/shared/types.js'
import {
  createTempHome,
  executeTool,
  removeTempHome,
  serviceContext,
  toolByName as findTool,
  type FakeExec,
} from './helpers/fixtures.js'
import { assertSupportedSchema } from './helpers/schema-guard.js'

const callerId = 'caller'
const defaultExec: FakeExec = { agent: { id: callerId } }

interface FakeAgentOverrides {
  readonly status?: string | undefined
  readonly inject?: (message: AgentMessage) => Promise<unknown>
  readonly followup?: (message: AgentMessage) => Promise<unknown>
  readonly steer?: (message: AgentMessage) => Promise<unknown>
}

interface AgentLookup {
  readonly get: (sessionId: string) => unknown
}

interface SessionLookup {
  readonly get: (sessionId: string) => unknown
}

interface SendCtxOptions {
  readonly agent?: FakeAgentOverrides
  readonly agents?: AgentLookup
  readonly sessions?: SessionLookup
  readonly workspaceRegistry?: { readonly archivedSessionIds: readonly unknown[] }
}

interface SendCalls {
  inject: AgentMessage[]
  followup: AgentMessage[]
  steer: AgentMessage[]
  resolveAgent: string[]
  inspect: string[]
}

function createCtx(options: SendCtxOptions = {}) {
  const calls: SendCalls = { inject: [], followup: [], steer: [], resolveAgent: [], inspect: [] }
  const overrides = options.agent ?? {}
  const agent = {
    status: 'status' in overrides ? overrides.status : 'idle',
    inject:
      overrides.inject ??
      (async (message: AgentMessage): Promise<void> => {
        calls.inject.push(message)
      }),
    followup:
      overrides.followup ??
      (async (message: AgentMessage): Promise<void> => {
        calls.followup.push(message)
      }),
    steer:
      overrides.steer ??
      (async (message: AgentMessage): Promise<void> => {
        calls.steer.push(message)
      }),
  }
  const ctx = serviceContext({
    sessionController: {
      resolveAgent: async (sessionId: string): Promise<unknown> => {
        calls.resolveAgent.push(sessionId)
        return { agent }
      },
      inspect: async (sessionId: string): Promise<unknown> => {
        calls.inspect.push(sessionId)
        return { events: [] }
      },
    },
    workspaceRegistry: options.workspaceRegistry ?? { archivedSessionIds: [] },
    agents: options.agents ?? { get: () => undefined },
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
  })
  return { ctx, calls, agent }
}

function toolByName(
  ctx: HostContext,
  toolName: string,
  permissionMode: PermissionMode = PermissionMode.Permissive,
): ToolDefinition {
  return findTool(createSendTools(ctx, { permissionMode }), toolName)
}

function runSend(
  args: unknown,
  ctx: HostContext,
  permissionMode: PermissionMode = PermissionMode.Permissive,
  exec: FakeExec = defaultExec,
): Promise<string> {
  return executeTool(toolByName(ctx, 'session_send', permissionMode), args, exec)
}

function runWake(
  args: unknown,
  ctx: HostContext,
  permissionMode: PermissionMode = PermissionMode.Permissive,
  exec: FakeExec = defaultExec,
): Promise<string> {
  return executeTool(toolByName(ctx, 'session_wake', permissionMode), args, exec)
}

function runWait(args: unknown, ctx: HostContext, exec: FakeExec = defaultExec): Promise<string> {
  return executeTool(toolByName(ctx, 'session_wait'), args, exec)
}

function assistantMessage(text: string) {
  return { type: 'assistant/message', data: { content: [{ type: 'text', text }] } }
}

const confirmErrorText = (sessionId: string): string =>
  `session-hub: CONFIRM_REQUIRED: session "${sessionId}" is not owned by the calling session`

const selfTargetText = 'session-hub: SELF_TARGET: a session cannot send a message to itself'

const archivedText = (sessionId: string): string =>
  `session-hub: SESSION_ARCHIVED: session "${sessionId}" is archived; call session_open first`

interface ToolParameters {
  readonly required: readonly string[]
  readonly properties: Record<string, Record<string, unknown>>
}

function parametersOf(tool: ToolDefinition): ToolParameters {
  return tool.parameters as unknown as ToolParameters
}

describe('session_send / session_wake / session_wait', () => {
  const tempHome = createTempHome('session-hub-send-')

  beforeEach(() => {
    process.env.DSH_HOME = tempHome
    fs.rmSync(ownerIndexPath(), { force: true })
  })

  after(() => {
    removeTempHome(tempHome)
  })

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

    const message = calls.inject[0]!
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
    const { ctx, calls } = createCtx({ agent: { status: SessionStatus.Running } })

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
    assert.deepEqual(calls.inject[0]!.content, [{ type: 'text', text: 'hello' }])
    assert.equal('senderSessionId' in calls.inject[0]!.source, false)
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

    const text = await runSend({ session_id: 'target', message: 'hello' }, ctx, PermissionMode.Owned)

    assert.equal(text, confirmErrorText('target'))
    assert.deepEqual(calls.resolveAgent, [])
  })

  test('session_send in owned mode does not accept the string "true" as confirmation', async () => {
    await recordOwner('target', 'other')
    const { ctx, calls } = createCtx()

    const text = await runSend(
      { session_id: 'target', message: 'hello', confirm: 'true' },
      ctx,
      PermissionMode.Owned,
    )

    assert.equal(text, confirmErrorText('target'))
    assert.deepEqual(calls.resolveAgent, [])
  })

  test('session_send in owned mode allows a non-owner with confirm: true', async () => {
    await recordOwner('target', 'other')
    const { ctx, calls } = createCtx()

    const text = await runSend(
      { session_id: 'target', message: 'hello', confirm: true },
      ctx,
      PermissionMode.Owned,
    )

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

    const text = await runSend({ session_id: 'target', message: 'hello' }, ctx, PermissionMode.Owned)

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
    const text = await runSend({ session_id: 'target', message: 'hello' }, serviceContext({}))

    assert.equal(text, 'session-hub: sessionController service is unavailable in this profile')
    await assert.rejects(
      deliver(serviceContext({}), { sessionId: 'target', text: 'hello' }),
      /session-hub: sessionController service is unavailable in this profile/,
    )
  })

  // --- session_wake ---------------------------------------------------------

  test('session_wake follows up on an idle target', async () => {
    await recordOwner('target', callerId)
    const { ctx, calls } = createCtx({ agent: { status: SessionStatus.Idle } })

    const text = await runWake({ session_id: 'target', message: 'hello there' }, ctx)

    assert.equal(text, '已请求会话 target 处理消息（idle → followup）')
    assert.deepEqual(calls.resolveAgent, ['target'])
    assert.equal(calls.followup.length, 1)
    assert.equal(calls.steer.length, 0)
    assert.equal(calls.inject.length, 0)

    const message = calls.followup[0]!
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
    const { ctx, calls } = createCtx({ agent: { status: SessionStatus.Running } })

    const text = await runWake({ session_id: 'target', message: 'hurry' }, ctx)

    assert.equal(text, '已请求会话 target 处理消息（running → steer）')
    assert.equal(calls.steer.length, 1)
    assert.equal(calls.followup.length, 0)
    assert.equal(calls.inject.length, 0)
    assert.deepEqual(calls.steer[0]!.content, [
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

    const text = await runWake({ session_id: 'target', message: 'hello' }, ctx, PermissionMode.Owned)

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
      PermissionMode.Owned,
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
      agents: {
        get: (sessionId: string) =>
          sessionId === 'target' ? { whenIdle: async () => { idleWaited += 1 } } : undefined,
      },
      sessions: {
        get: (sessionId: string) =>
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
    ctx.sessionController.inspect = async (sessionId: string) => {
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
    const { ctx } = createCtx({
      agents: {
        get: () => ({
          whenIdle: () => new Promise<void>(() => {}),
        }),
      },
    })

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

    const tool = toolByName(ctx, 'session_wait')
    const text = await executeTool(tool, { session_id: 'target' })
    const replyLine = text.split('\n')[1] ?? ''

    assert.ok(text.startsWith('会话 target 已空闲\n- reply: '))
    assert.equal(Array.from(replyLine.slice('- reply: '.length)).length, 2001)
    assert.ok(replyLine.endsWith('…'))
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

    for (const permissionMode of [PermissionMode.Permissive, PermissionMode.Owned]) {
      for (const tool of createSendTools(ctx, { permissionMode })) {
        const label = `${tool.name} (${permissionMode})`
        assertSupportedSchema(tool.parameters, `${label}.parameters`)
        assertSupportedSchema(tool.output.schema, `${label}.output.schema`)
        for (const [name, schema] of Object.entries(parametersOf(tool).properties)) {
          assert.equal('minimum' in schema, false, `${label}.${name}: "minimum" is not supported`)
          assert.equal('maximum' in schema, false, `${label}.${name}: "maximum" is not supported`)
        }
      }
    }
  })

  test('permissive messaging schemas omit confirm', () => {
    const { ctx } = createCtx()

    for (const toolName of ['session_send', 'session_wake', 'session_wait']) {
      const tool = toolByName(ctx, toolName, PermissionMode.Permissive)
      assert.equal('confirm' in parametersOf(tool).properties, false, `${toolName} must omit confirm`)
    }
  })

  test('owned send and wake schemas declare confirm, wait never does', () => {
    const { ctx } = createCtx()
    const send = parametersOf(toolByName(ctx, 'session_send', PermissionMode.Owned))
    const wake = parametersOf(toolByName(ctx, 'session_wake', PermissionMode.Owned))
    const wait = parametersOf(toolByName(ctx, 'session_wait', PermissionMode.Owned))

    assert.equal(send.properties.confirm?.type, 'boolean')
    assert.equal(wake.properties.confirm?.type, 'boolean')
    assert.equal('confirm' in wait.properties, false)
  })

  test('send and wake declare only a target and a message', () => {
    const { ctx } = createCtx()

    for (const toolName of ['session_send', 'session_wake']) {
      const parameters = parametersOf(toolByName(ctx, toolName))
      assert.deepEqual(parameters.required, ['session_id', 'message'])
      assert.deepEqual(Object.keys(parameters.properties).sort(), ['message', 'session_id'])
    }
  })

  test('session_wait declares a session id and an integer timeout', () => {
    const parameters = parametersOf(toolByName(createCtx().ctx, 'session_wait'))

    assert.deepEqual(parameters.required, ['session_id'])
    assert.deepEqual(Object.keys(parameters.properties).sort(), ['session_id', 'timeout_ms'])
    assert.equal(parameters.properties.timeout_ms?.type, 'integer')
    assert.equal(parameters.properties.timeout_ms?.default, 120000)
  })
})
