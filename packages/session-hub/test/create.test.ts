import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { ownerIndexPath, readOwnerIndex, recordOwner } from '../src/host/owner-index.js'
import { createSessionCreateTool } from '../src/tools/create.js'
import type { AgentMessage, HostContext } from '../src/shared/types.js'
import {
  createTempHome,
  executeTool,
  removeTempHome,
  serviceContext,
  type FakeExec,
  type FakeExecAgent,
} from './helpers/fixtures.js'
import { assertSupportedSchema } from './helpers/schema-guard.js'

const callerId = 'caller'
const alphaDir = path.resolve('/fixtures/alpha')
const betaDir = path.resolve('/fixtures/beta')

const workspaces = [
  { id: 'ws-alpha', title: 'Alpha Workspace', path: alphaDir },
  { id: 'ws-beta', title: 'Beta Workspace', path: betaDir },
]

const catalog = {
  default: { provider: 'p1', model: 'model-a' },
  routableProviders: ['p1', 'p2'],
  groups: [
    {
      id: 'p1',
      name: 'Provider One',
      models: [
        { id: 'model-a', name: 'Model A' },
        { id: 'shared', name: 'Shared Model' },
      ],
    },
    {
      id: 'p2',
      name: 'Provider Two',
      models: [
        { id: 'model-b', name: 'Model B' },
        { id: 'shared', name: 'Shared Model' },
      ],
    },
  ],
  failures: [],
}

interface CreateCalls {
  create: unknown[]
  rename: unknown[]
  selectModel: unknown[]
  modelCatalog: number
  resolveAgent: string[]
  followup: AgentMessage[]
  steer: AgentMessage[]
}

function createCtx() {
  const calls: CreateCalls = {
    create: [],
    rename: [],
    selectModel: [],
    modelCatalog: 0,
    resolveAgent: [],
    followup: [],
    steer: [],
  }
  const targetAgent = {
    followup: async (message: AgentMessage): Promise<void> => {
      calls.followup.push(message)
    },
    steer: async (message: AgentMessage): Promise<void> => {
      calls.steer.push(message)
    },
  }
  const ctx = serviceContext({
    sessionController: {
      create: async (request: unknown): Promise<{ readonly sessionId?: string }> => {
        calls.create.push(request)
        return { sessionId: 'new-session' }
      },
      rename: async (request: unknown): Promise<unknown> => {
        calls.rename.push(request)
        return {}
      },
      selectModel: async (request: unknown): Promise<unknown> => {
        calls.selectModel.push(request)
        return {}
      },
      modelCatalog: async (): Promise<unknown> => {
        calls.modelCatalog += 1
        return catalog
      },
      resolveAgent: async (sessionId: string): Promise<unknown> => {
        calls.resolveAgent.push(sessionId)
        return { agent: targetAgent }
      },
    },
    workspaceRegistry: { list: async () => workspaces },
  })
  return { ctx, calls, targetAgent }
}

function execWithCwd(cwd?: string): FakeExec {
  const agent: FakeExecAgent = { id: callerId }
  if (cwd === undefined) return { agent }
  return { agent: { id: callerId, session: { header: { cwd } } } }
}

const defaultExec = execWithCwd()

async function runCreate(
  args: Record<string, unknown>,
  ctx: HostContext = createCtx().ctx,
  exec: FakeExec = defaultExec,
): Promise<string> {
  // Every valid create carries the required initial task; tests that exercise
  // the missing-message path call the tool directly.
  return executeTool(
    createSessionCreateTool(ctx),
    { message: 'build the thing', ...args },
    exec,
  )
}

describe('session_create', () => {
  const tempHome = createTempHome('session-hub-create-')

  beforeEach(() => {
    process.env.DSH_HOME = tempHome
    fs.rmSync(ownerIndexPath(), { force: true })
  })

  after(() => {
    removeTempHome(tempHome)
  })

  test('session_create sends an empty create request for the required task only', async () => {
    const { ctx, calls } = createCtx()

    const text = await runCreate({}, ctx)

    assert.deepEqual(calls.create, [{}])
    assert.equal(calls.followup.length, 1)
    assert.equal(
      text,
      [
        '已创建会话 new-session',
        '- workspace: -',
        '- cwd: -',
        '- agentPreset: -',
        '- owner: self',
        '- started: 已投递初始任务',
      ].join('\n'),
    )
  })

  test('session_create inherits the caller cwd when no target is given', async () => {
    const { ctx, calls } = createCtx()
    const callerCwd = path.join(alphaDir, 'sub')

    await runCreate({}, ctx, execWithCwd(callerCwd))

    assert.deepEqual(calls.create, [{ cwd: callerCwd }])
  })

  test('session_create sends an explicit cwd in normalized form', async () => {
    const { ctx, calls } = createCtx()
    const rawCwd = `${alphaDir.toUpperCase()}${path.sep}`

    const text = await runCreate({ cwd: rawCwd }, ctx)

    assert.deepEqual(calls.create, [{ cwd: alphaDir.toUpperCase() }])
    assert.match(text, new RegExp(`^- cwd: ${escapeRegExp(alphaDir.toUpperCase())}$`, 'm'))
  })

  test('session_create resolves a workspace by exact id', async () => {
    const { ctx, calls } = createCtx()

    const text = await runCreate({ workspace: 'ws-alpha' }, ctx)

    assert.deepEqual(calls.create, [{ workspaceId: 'ws-alpha' }])
    assert.match(text, /^- workspace: Alpha Workspace$/m)
    assert.match(text, /^- cwd: -$/m)
  })

  test('session_create resolves a workspace by case-insensitive title', async () => {
    const { ctx, calls } = createCtx()

    const text = await runCreate({ workspace: 'alpha workspace' }, ctx)

    assert.deepEqual(calls.create, [{ workspaceId: 'ws-alpha' }])
    assert.match(text, /^- workspace: Alpha Workspace$/m)
  })

  test('session_create resolves a workspace by normalized path', async () => {
    const { ctx, calls } = createCtx()

    await runCreate({ workspace: `${alphaDir.toUpperCase()}${path.sep}` }, ctx)

    assert.deepEqual(calls.create, [{ workspaceId: 'ws-alpha' }])
  })

  test('session_create rejects workspace together with cwd', async () => {
    const { ctx, calls } = createCtx()

    const text = await runCreate({ workspace: 'ws-alpha', cwd: betaDir }, ctx)

    assert.equal(text, 'session-hub: workspace and cwd are mutually exclusive')
    assert.equal(calls.create.length, 0)
  })

  test('session_create reports an unknown workspace', async () => {
    const { ctx, calls } = createCtx()

    const text = await runCreate({ workspace: 'no-such-workspace' }, ctx)

    assert.equal(text, 'session-hub: workspace "no-such-workspace" not found')
    assert.equal(calls.create.length, 0)
  })

  test('session_create renames the new session when a title is given', async () => {
    const { ctx, calls } = createCtx()

    const text = await runCreate({ title: 'Build the thing' }, ctx)

    assert.deepEqual(calls.create, [{}])
    assert.deepEqual(calls.rename, [{ sessionId: 'new-session', title: 'Build the thing' }])
    assert.match(text, /^已创建会话 new-session$/m)
  })

  test('session_create keeps the creation result when rename fails', async () => {
    const { ctx, calls } = createCtx()
    ctx.sessionController.rename = async (request: unknown) => {
      calls.rename.push(request)
      throw new Error('rename denied')
    }

    const text = await runCreate({ title: 'Build the thing' }, ctx)

    assert.match(text, /^已创建会话 new-session$/m)
    assert.match(text, /^- title: 设置失败（rename denied）$/m)
  })

  test('session_create selects an explicit model after creation', async () => {
    const { ctx, calls } = createCtx()

    const text = await runCreate(
      { model: 'model-b', provider: 'p2', reasoning_effort: 'low' },
      ctx,
    )

    assert.deepEqual(calls.create, [{}])
    assert.equal(calls.modelCatalog, 0)
    assert.deepEqual(calls.selectModel, [
      { sessionId: 'new-session', provider: 'p2', model: 'model-b', reasoningEffort: 'low' },
    ])
    assert.match(text, /^已创建会话 new-session$/m)
    assert.match(text, /^- model: p2\/model-b$/m)
  })

  test('session_create resolves a model through the catalog', async () => {
    const { ctx, calls } = createCtx()

    const text = await runCreate({ model: 'model-a' }, ctx)

    assert.equal(calls.modelCatalog, 1)
    assert.deepEqual(calls.selectModel, [{ sessionId: 'new-session', provider: 'p1', model: 'model-a' }])
    assert.match(text, /^- model: p1\/model-a$/m)
  })

  test('session_create appends the model line after the title line', async () => {
    const { ctx } = createCtx()

    const text = await runCreate({ title: 'Build the thing', model: 'model-a', provider: 'p1' }, ctx)

    assert.ok(text.indexOf('- title: Build the thing') < text.indexOf('- model: p1/model-a'))
  })

  test('session_create keeps the session when the model cannot be resolved', async () => {
    const { ctx, calls } = createCtx()

    const text = await runCreate({ model: 'nope' }, ctx)

    assert.deepEqual(calls.create, [{}])
    assert.deepEqual(calls.selectModel, [])
    assert.match(text, /^已创建会话 new-session$/m)
    assert.match(text, /^- model: 失败（session-hub: model "nope" is not routable）$/m)
  })

  test('session_create keeps the session when only reasoning_effort is given', async () => {
    const { ctx, calls } = createCtx()

    const text = await runCreate({ reasoning_effort: 'high' }, ctx)

    assert.deepEqual(calls.create, [{}])
    assert.deepEqual(calls.selectModel, [])
    assert.match(text, /^已创建会话 new-session$/m)
    assert.match(text, /^- model: 失败（session-hub: reasoning_effort requires model）$/m)
  })

  test('session_create forwards agent_preset as agentPreset', async () => {
    const { ctx, calls } = createCtx()

    const text = await runCreate({ agent_preset: 'explorer' }, ctx)

    assert.deepEqual(calls.create, [{ agentPreset: 'explorer' }])
    assert.match(text, /^- agentPreset: explorer$/m)
  })

  test('session_create delivers the required message as the initial task', async () => {
    const { ctx, calls } = createCtx()

    const text = await runCreate({ message: '  hello there  ' }, ctx)

    assert.deepEqual(calls.resolveAgent, ['new-session'])
    assert.equal(calls.followup.length, 1)
    assert.equal(calls.steer.length, 0)

    const message = calls.followup[0]!
    assert.equal(message.role, 'user')
    assert.deepEqual(message.content, [
      { type: 'text', text: `Agent ${callerId} sent a message:\n\nhello there` },
    ])
    assert.equal(message.source.kind, 'agent-message')
    assert.equal(message.source.form, 'relay')
    assert.equal(message.source.senderSessionId, callerId)
    assert.match(text, /^- started: 已投递初始任务$/m)
  })

  test('session_create starts the new session immediately after rename and model selection', async () => {
    const { ctx } = createCtx()

    const text = await runCreate(
      { title: 'Build the thing', model: 'model-a', provider: 'p1', message: 'go' },
      ctx,
    )

    assert.ok(text.indexOf('- model: p1/model-a') < text.indexOf('- started: 已投递初始任务'))
  })

  test('session_create keeps the session when the initial task cannot be delivered', async () => {
    const { ctx, calls } = createCtx()
    ctx.sessionController.resolveAgent = async (sessionId: string) => {
      calls.resolveAgent.push(sessionId)
      return { error: { code: 'session/not-found', message: 'gone' } }
    }

    const text = await runCreate({ message: 'hello' }, ctx)

    assert.deepEqual(calls.create, [{}])
    assert.deepEqual(calls.followup, [])
    assert.match(text, /^已创建会话 new-session$/m)
    assert.match(text, /^- started: 失败（session-hub: send failed: session\/not-found）$/m)
  })

  test('session_create requires a non-empty message', async () => {
    const { ctx, calls } = createCtx()

    assert.equal(
      await executeTool(createSessionCreateTool(ctx), {}, defaultExec),
      'session-hub: message is required',
    )
    assert.equal(
      await executeTool(createSessionCreateTool(ctx), { message: '   ' }, defaultExec),
      'session-hub: message is required',
    )
    assert.deepEqual(calls.create, [])
    assert.deepEqual(calls.resolveAgent, [])
  })

  test('session_create records ownership in the owner index', async () => {
    const { ctx } = createCtx()

    await runCreate({}, ctx)

    const owners = await readOwnerIndex()
    assert.equal(owners['new-session']?.ownerSessionId, callerId)
    assert.equal(typeof owners['new-session']?.createdAt, 'number')
  })

  test('session_create keeps existing owner entries when recording a new one', async () => {
    await recordOwner('older-session', 'older-owner')
    const { ctx } = createCtx()

    await runCreate({}, ctx)

    const owners = await readOwnerIndex()
    assert.equal(owners['older-session']?.ownerSessionId, 'older-owner')
    assert.equal(owners['new-session']?.ownerSessionId, callerId)
  })

  test('session_create reports an unknown owner when the caller id is missing', async () => {
    const { ctx } = createCtx()

    const text = await runCreate({}, ctx, { agent: {} })

    assert.match(text, /^- owner: 未知（调用方会话 id 不可用）$/m)
    assert.deepEqual(await readOwnerIndex(), {})
  })

  test('session_create returns an error text when sessionController is missing', async () => {
    const text = await runCreate(
      {},
      serviceContext({ workspaceRegistry: { list: async () => workspaces } }),
    )

    assert.equal(text, 'session-hub: sessionController service is unavailable in this profile')
  })

  test('session_create wraps host create failures', async () => {
    const { ctx } = createCtx()
    ctx.sessionController.create = async () => {
      throw new Error('boom')
    }

    const text = await runCreate({}, ctx)

    assert.equal(text, 'session-hub: create failed: boom')
  })

  test('session_create reports a create response without a session id', async () => {
    const { ctx } = createCtx()
    ctx.sessionController.create = async () => ({})

    const text = await runCreate({}, ctx)

    assert.equal(text, 'session-hub: create failed: host returned no session id')
  })

  test('session_create schema stays within the supported keyword subset', () => {
    const tool = createSessionCreateTool(createCtx().ctx)

    assertSupportedSchema(tool.parameters, 'session_create.parameters')
    assertSupportedSchema(tool.output.schema, 'session_create.output.schema')
    for (const [name, schema] of Object.entries(propertiesOf(tool))) {
      assert.equal('minimum' in schema, false, `session_create.${name}: "minimum" is not supported`)
      assert.equal('maximum' in schema, false, `session_create.${name}: "maximum" is not supported`)
    }
  })

  test('session_create requires a message and no longer takes initial_message', () => {
    const parameters = parametersOf(createSessionCreateTool(createCtx().ctx))

    assert.deepEqual(parameters.required, ['message'])
    assert.equal(parameters.properties.message?.type, 'string')
    assert.equal('initial_message' in parameters.properties, false)
  })
})

interface ToolParameters {
  readonly required: readonly string[]
  readonly properties: Record<string, Record<string, unknown>>
}

function parametersOf(tool: ToolDefinition): ToolParameters {
  return tool.parameters as unknown as ToolParameters
}

function propertiesOf(tool: ToolDefinition): Record<string, Record<string, unknown>> {
  return parametersOf(tool).properties
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
