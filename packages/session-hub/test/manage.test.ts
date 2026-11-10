import assert from 'node:assert/strict'
import fs from 'node:fs'
import { after, beforeEach, describe, test } from 'node:test'

import { ownerIndexPath, recordOwner } from '../src/host/owner-index.js'
import { createManageTools } from '../src/tools/manage.js'
import type { HostContext } from '../src/shared/types.js'
import {
  createTempHome,
  executeTool,
  removeTempHome,
  serviceContext,
  toolByName as findTool,
  type FakeExec,
} from './helpers/fixtures.js'
import { assertSupportedSchema } from './helpers/schema-guard.js'
import { createSettings } from './helpers/settings.js'

const callerId = 'caller'

/** The old "non-owned confirm policy" behaviour, now expressed as a confirm policy. */
const OWNED_POLICY = { confirm: 'non-owned' } as const

/** The old "never confirm policy" behaviour, now expressed as a confirm policy. */
const PERMISSIVE_POLICY = { confirm: 'never' } as const

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

interface ManageCalls {
  rename: unknown[]
  selectModel: unknown[]
  modelCatalog: number
  archiveSession: unknown[]
  unarchiveSession: unknown[]
}

function createCtx() {
  const calls: ManageCalls = {
    rename: [],
    selectModel: [],
    modelCatalog: 0,
    archiveSession: [],
    unarchiveSession: [],
  }
  const ctx = serviceContext({
    sessionController: {
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
    },
    workspaceController: {
      archiveSession: async (request: unknown): Promise<unknown> => {
        calls.archiveSession.push(request)
        return {}
      },
      unarchiveSession: async (request: unknown): Promise<unknown> => {
        calls.unarchiveSession.push(request)
        return {}
      },
    },
  })
  return { ctx, calls }
}

// The existing authorization tests describe the non-owned confirmation policy;
// permissive tests opt in explicitly so the default of this helper cannot hide
// a regression.
function toolByName(
  ctx: HostContext,
  name: string,
  policy: Readonly<Record<string, unknown>> = OWNED_POLICY,
) {
  return findTool(createManageTools(ctx, createSettings({ [name]: policy })), name)
}

function run(
  name: string,
  args: unknown,
  ctx: HostContext,
  policy: Readonly<Record<string, unknown>> = OWNED_POLICY,
  exec: FakeExec = { agent: { id: callerId } },
): Promise<string> {
  return executeTool(toolByName(ctx, name, policy), args, exec)
}

const confirmErrorText = (sessionId: string): string =>
  `session-hub: CONFIRM_REQUIRED: session "${sessionId}" is not owned by the calling session`

const targetNotAllowedText = (sessionId: string): string =>
  `session-hub: TARGET_NOT_ALLOWED: session "${sessionId}" is not owned by the calling session`

const selfCloseErrorText = 'session-hub: SELF_CLOSE_FORBIDDEN: a session cannot close itself'

interface ToolParameters {
  readonly required: readonly string[]
  readonly properties: Record<string, Record<string, unknown>>
}

function parametersOf(tool: ReturnType<typeof findTool>): ToolParameters {
  return tool.parameters as unknown as ToolParameters
}

describe('session_update / close / open', () => {
  const tempHome = createTempHome('session-hub-manage-')

  beforeEach(() => {
    process.env.DSH_HOME = tempHome
    fs.rmSync(ownerIndexPath(), { force: true })
  })

  after(() => {
    removeTempHome(tempHome)
  })

  // --- session_update -------------------------------------------------------

  test('session_update lets the owner rename its session without confirmation', async () => {
    await recordOwner('target', callerId)
    const { ctx, calls } = createCtx()

    const text = await run('session_update', { session_id: 'target', title: ' Renamed ' }, ctx)

    assert.equal(text, ['已更新会话 target', '- title: Renamed'].join('\n'))
    assert.deepEqual(calls.rename, [{ sessionId: 'target', title: 'Renamed' }])
    assert.equal(calls.modelCatalog, 0)
  })

  test('session_update rejects a non-owner without confirmation and applies nothing', async () => {
    await recordOwner('target', 'other')
    const { ctx, calls } = createCtx()

    const text = await run('session_update', { session_id: 'target', title: 'Renamed' }, ctx)

    assert.equal(text, confirmErrorText('target'))
    assert.deepEqual(calls.rename, [])
    assert.deepEqual(calls.selectModel, [])
    assert.equal(calls.modelCatalog, 0)
  })

  test('session_update allows a non-owner with confirm: true', async () => {
    await recordOwner('target', 'other')
    const { ctx, calls } = createCtx()

    const text = await run(
      'session_update',
      { session_id: 'target', title: 'Renamed', confirm: true },
      ctx,
    )

    assert.deepEqual(calls.rename, [{ sessionId: 'target', title: 'Renamed' }])
    assert.equal(text, ['已更新会话 target', '- title: Renamed'].join('\n'))
  })

  test('session_update does not accept the string "true" as confirmation', async () => {
    await recordOwner('target', 'other')
    const { ctx, calls } = createCtx()

    const text = await run(
      'session_update',
      { session_id: 'target', title: 'Renamed', confirm: 'true' },
      ctx,
    )

    assert.equal(text, confirmErrorText('target'))
    assert.deepEqual(calls.rename, [])
  })

  test('session_update applies to a session created by another session in never confirm policy', async () => {
    await recordOwner('target', 'other')
    const { ctx, calls } = createCtx()

    const text = await run(
      'session_update',
      { session_id: 'target', title: ' Renamed ' },
      ctx,
      PERMISSIVE_POLICY,
    )

    assert.equal(text, ['已更新会话 target', '- title: Renamed'].join('\n'))
    assert.deepEqual(calls.rename, [{ sessionId: 'target', title: 'Renamed' }])
    assert.deepEqual(calls.selectModel, [])
  })

  test('session_update requires at least one change', async () => {
    await recordOwner('target', callerId)
    const { ctx } = createCtx()

    const text = await run('session_update', { session_id: 'target' }, ctx)

    assert.equal(text, 'session-hub: nothing to update')
  })

  test('session_update requires a session id', async () => {
    const { ctx } = createCtx()

    const text = await run('session_update', {}, ctx)

    assert.equal(text, 'session-hub: session_id is required')
  })

  test('session_update resolves a model through the catalog', async () => {
    await recordOwner('target', callerId)
    const { ctx, calls } = createCtx()

    const text = await run('session_update', { session_id: 'target', model: 'model-a' }, ctx)

    assert.equal(calls.modelCatalog, 1)
    assert.deepEqual(calls.selectModel, [{ sessionId: 'target', provider: 'p1', model: 'model-a' }])
    assert.equal(text, ['已更新会话 target', '- model: p1/model-a'].join('\n'))
  })

  test('session_update forwards an explicit provider and reasoning effort', async () => {
    await recordOwner('target', callerId)
    const { ctx, calls } = createCtx()

    const text = await run(
      'session_update',
      {
        session_id: 'target',
        provider: 'p2',
        model: 'model-b',
        reasoning_effort: 'high',
      },
      ctx,
    )

    assert.equal(calls.modelCatalog, 0)
    assert.deepEqual(calls.selectModel, [
      { sessionId: 'target', provider: 'p2', model: 'model-b', reasoningEffort: 'high' },
    ])
    assert.equal(text, ['已更新会话 target', '- model: p2/model-b (high)'].join('\n'))
  })

  test('session_update reports an unknown model', async () => {
    await recordOwner('target', callerId)
    const { ctx, calls } = createCtx()

    const text = await run('session_update', { session_id: 'target', model: 'nope' }, ctx)

    assert.equal(text, 'session-hub: model "nope" is not routable')
    assert.deepEqual(calls.selectModel, [])
  })

  test('session_update asks for a provider when a model is offered by several', async () => {
    await recordOwner('target', callerId)
    const { ctx, calls } = createCtx()

    const text = await run('session_update', { session_id: 'target', model: 'shared' }, ctx)

    assert.equal(
      text,
      'session-hub: model "shared" is offered by multiple providers; pass provider',
    )
    assert.deepEqual(calls.selectModel, [])
  })

  test('session_update requires model when only reasoning_effort is given', async () => {
    await recordOwner('target', callerId)
    const { ctx, calls } = createCtx()

    const text = await run('session_update', { session_id: 'target', reasoning_effort: 'high' }, ctx)

    assert.equal(text, 'session-hub: reasoning_effort requires model')
    assert.equal(calls.modelCatalog, 0)
  })

  test('session_update requires model when only provider is given', async () => {
    await recordOwner('target', callerId)
    const { ctx, calls } = createCtx()

    const text = await run('session_update', { session_id: 'target', provider: 'p1' }, ctx)

    assert.equal(text, 'session-hub: provider requires model')
    assert.deepEqual(calls.selectModel, [])
  })

  test('session_update reports model catalog failures', async () => {
    await recordOwner('target', callerId)
    const { ctx, calls } = createCtx()
    ctx.sessionController.modelCatalog = async () => {
      throw new Error('boom')
    }

    const text = await run('session_update', { session_id: 'target', model: 'model-a' }, ctx)

    assert.equal(text, 'session-hub: model catalog unavailable: boom')
    assert.deepEqual(calls.selectModel, [])
  })

  test('session_update reports the title change when the model cannot be resolved', async () => {
    await recordOwner('target', callerId)
    const { ctx, calls } = createCtx()

    const text = await run(
      'session_update',
      { session_id: 'target', title: 'Renamed', model: 'nope' },
      ctx,
    )

    assert.deepEqual(calls.rename, [{ sessionId: 'target', title: 'Renamed' }])
    assert.deepEqual(calls.selectModel, [])
    assert.equal(
      text,
      [
        '已更新会话 target',
        '- title: Renamed',
        '- model: 失败（session-hub: model "nope" is not routable）',
      ].join('\n'),
    )
  })

  test('session_update reports selectModel failures without dropping the title change', async () => {
    await recordOwner('target', callerId)
    const { ctx, calls } = createCtx()
    ctx.sessionController.selectModel = async (request: unknown) => {
      calls.selectModel.push(request)
      throw new Error('select denied')
    }

    const text = await run(
      'session_update',
      { session_id: 'target', title: 'Renamed', provider: 'p1', model: 'model-a' },
      ctx,
    )

    assert.equal(
      text,
      ['已更新会话 target', '- title: Renamed', '- model: 失败（select denied）'].join('\n'),
    )
  })

  // --- session_close --------------------------------------------------------

  test('session_close closes a session created by the caller without confirmation', async () => {
    await recordOwner('child', callerId)
    const { ctx, calls } = createCtx()

    const text = await run('session_close', { session_id: 'child' }, ctx)

    assert.deepEqual(calls.archiveSession, [{ sessionId: 'child', stopActivity: true }])
    assert.equal(text, '已关闭会话 child（已归档，可用 session_open 恢复）')
  })

  test('session_close refuses to close the calling session in non-owned confirm policy', async () => {
    await recordOwner(callerId, 'creator')
    const { ctx, calls } = createCtx()

    const text = await run('session_close', { session_id: callerId }, ctx)

    assert.equal(text, selfCloseErrorText)
    assert.deepEqual(calls.archiveSession, [])
  })

  test('session_close has no confirm escape hatch for self-close in non-owned confirm policy', async () => {
    await recordOwner(callerId, 'creator')
    const { ctx, calls } = createCtx()

    const text = await run('session_close', { session_id: callerId, confirm: true }, ctx)

    assert.equal(text, selfCloseErrorText)
    assert.deepEqual(calls.archiveSession, [])
  })

  test('session_close does not accept the string "true" as confirmation', async () => {
    await recordOwner('target', 'other')
    const { ctx, calls } = createCtx()

    const text = await run('session_close', { session_id: 'target', confirm: 'true' }, ctx)

    assert.equal(text, confirmErrorText('target'))
    assert.deepEqual(calls.archiveSession, [])
  })

  test('session_close requires confirmation for a session created by another session', async () => {
    await recordOwner('target', 'other')
    const { ctx, calls } = createCtx()

    const text = await run('session_close', { session_id: 'target' }, ctx)

    assert.equal(text, confirmErrorText('target'))
    assert.deepEqual(calls.archiveSession, [])
  })

  test('session_close survives a missing workspaceController', async () => {
    await recordOwner('child', callerId)
    const { ctx } = createCtx()
    Reflect.deleteProperty(ctx, 'workspaceController')

    const text = await run('session_close', { session_id: 'child' }, ctx)

    assert.equal(text, 'session-hub: workspaceController service is unavailable in this profile')
  })

  test('session_close wraps archive failures', async () => {
    await recordOwner('child', callerId)
    const { ctx } = createCtx()
    ctx.workspaceController.archiveSession = async () => {
      throw new Error('boom')
    }

    const text = await run('session_close', { session_id: 'child' }, ctx)

    assert.equal(text, 'session-hub: close failed: boom')
  })

  test('session_close requires a session id', async () => {
    const { ctx } = createCtx()

    const text = await run('session_close', {}, ctx)

    assert.equal(text, 'session-hub: session_id is required')
  })

  test('session_close archives any session in never confirm policy', async () => {
    await recordOwner('target', 'other')
    const { ctx, calls } = createCtx()

    const text = await run('session_close', { session_id: 'target' }, ctx, PERMISSIVE_POLICY)

    assert.deepEqual(calls.archiveSession, [{ sessionId: 'target', stopActivity: true }])
    assert.equal(text, '已关闭会话 target（已归档，可用 session_open 恢复）')
  })

  test('session_close refuses to close the calling session in never confirm policy', async () => {
    await recordOwner(callerId, 'creator')
    const { ctx, calls } = createCtx()

    const text = await run('session_close', { session_id: callerId }, ctx, PERMISSIVE_POLICY)

    assert.equal(text, selfCloseErrorText)
    assert.deepEqual(calls.archiveSession, [])
  })

  test('session_close has no confirm escape hatch for self-close in never confirm policy', async () => {
    await recordOwner(callerId, 'creator')
    const { ctx, calls } = createCtx()

    const text = await run(
      'session_close',
      { session_id: callerId, confirm: true },
      ctx,
      PERMISSIVE_POLICY,
    )

    assert.equal(text, selfCloseErrorText)
    assert.deepEqual(calls.archiveSession, [])
  })

  // --- session_open ---------------------------------------------------------

  test('session_open unarchives the session without confirmation', async () => {
    const { ctx, calls } = createCtx()

    const text = await run('session_open', { session_id: 'archived' }, ctx, PERMISSIVE_POLICY)

    assert.deepEqual(calls.unarchiveSession, [{ sessionId: 'archived' }])
    assert.equal(text, '已恢复会话 archived')
  })

  test('session_open is idempotent', async () => {
    const { ctx, calls } = createCtx()

    const first = await run('session_open', { session_id: 'archived' }, ctx, PERMISSIVE_POLICY)
    const second = await run('session_open', { session_id: 'archived' }, ctx, PERMISSIVE_POLICY)

    assert.equal(first, '已恢复会话 archived')
    assert.equal(second, '已恢复会话 archived')
    assert.deepEqual(calls.unarchiveSession, [
      { sessionId: 'archived' },
      { sessionId: 'archived' },
    ])
  })

  test('session_open reports a missing workspaceController', async () => {
    const { ctx } = createCtx()
    Reflect.deleteProperty(ctx, 'workspaceController')

    const text = await run('session_open', { session_id: 'archived' }, ctx, PERMISSIVE_POLICY)

    assert.equal(text, 'session-hub: workspaceController service is unavailable in this profile')
  })

  test('session_open wraps unarchive failures', async () => {
    const { ctx } = createCtx()
    ctx.workspaceController.unarchiveSession = async () => {
      throw new Error('boom')
    }

    const text = await run('session_open', { session_id: 'archived' }, ctx, PERMISSIVE_POLICY)

    assert.equal(text, 'session-hub: open failed: boom')
  })

  test('session_open requires a session id', async () => {
    const { ctx } = createCtx()

    const text = await run('session_open', {}, ctx, PERMISSIVE_POLICY)

    assert.equal(text, 'session-hub: session_id is required')
  })

  // --- policy ---------------------------------------------------------------

  test('targets "owned" rejects a non-owner even with confirm: true', async () => {
    await recordOwner('target', 'other')
    const { ctx, calls } = createCtx()

    const text = await run(
      'session_update',
      { session_id: 'target', title: 'Renamed', confirm: true },
      ctx,
      { targets: 'owned' },
    )

    assert.equal(text, targetNotAllowedText('target'))
    assert.deepEqual(calls.rename, [])
  })

  test('targets "owned" allows the owner', async () => {
    await recordOwner('target', callerId)
    const { ctx, calls } = createCtx()

    const text = await run(
      'session_update',
      { session_id: 'target', title: 'Renamed' },
      ctx,
      { targets: 'owned' },
    )

    assert.equal(text, ['已更新会话 target', '- title: Renamed'].join('\n'))
    assert.deepEqual(calls.rename, [{ sessionId: 'target', title: 'Renamed' }])
  })

  test('confirm "always" requires confirmation even for the owner', async () => {
    await recordOwner('target', callerId)
    const { ctx, calls } = createCtx()

    const denied = await run(
      'session_update',
      { session_id: 'target', title: 'Renamed' },
      ctx,
      { confirm: 'always' },
    )
    assert.equal(denied, confirmErrorText('target'))
    assert.deepEqual(calls.rename, [])

    const allowed = await run(
      'session_update',
      { session_id: 'target', title: 'Renamed', confirm: true },
      ctx,
      { confirm: 'always' },
    )
    assert.equal(allowed, ['已更新会话 target', '- title: Renamed'].join('\n'))
  })

  test('session_update allowSelf: false rejects updating the caller', async () => {
    const { ctx, calls } = createCtx()

    const text = await run(
      'session_update',
      { session_id: callerId, title: 'Renamed' },
      ctx,
      { allowSelf: false },
    )

    assert.equal(text, 'session-hub: SELF_TARGET: a session cannot update itself')
    assert.deepEqual(calls.rename, [])
  })

  test('session_update allows updating the caller by default', async () => {
    const { ctx, calls } = createCtx()

    const text = await run('session_update', { session_id: callerId, title: 'Renamed' }, ctx, {})

    assert.equal(text, ['已更新会话 caller', '- title: Renamed'].join('\n'))
    assert.deepEqual(calls.rename, [{ sessionId: callerId, title: 'Renamed' }])
  })

  test('session_close allowSelf: true allows closing the caller', async () => {
    await recordOwner(callerId, 'creator')
    const { ctx, calls } = createCtx()

    const text = await run(
      'session_close',
      { session_id: callerId },
      ctx,
      { allowSelf: true },
    )

    assert.equal(text, '已关闭会话 caller（已归档，可用 session_open 恢复）')
    assert.deepEqual(calls.archiveSession, [{ sessionId: callerId, stopActivity: true }])
  })

  test('session_close targets "owned" rejects a session created by another session', async () => {
    await recordOwner('target', 'other')
    const { ctx, calls } = createCtx()

    const text = await run('session_close', { session_id: 'target' }, ctx, { targets: 'owned' })

    assert.equal(text, targetNotAllowedText('target'))
    assert.deepEqual(calls.archiveSession, [])
  })

  test('session_open enforces its own targets and confirm policy', async () => {
    await recordOwner('archived', 'other')

    const targetDenied = await run(
      'session_open',
      { session_id: 'archived' },
      createCtx().ctx,
      { targets: 'owned' },
    )
    assert.equal(targetDenied, targetNotAllowedText('archived'))

    const confirmDenied = await run(
      'session_open',
      { session_id: 'archived' },
      createCtx().ctx,
      { confirm: 'always' },
    )
    assert.equal(confirmDenied, confirmErrorText('archived'))

    const { ctx, calls } = createCtx()
    const allowed = await run(
      'session_open',
      { session_id: 'archived', confirm: true },
      ctx,
      { confirm: 'always' },
    )
    assert.equal(allowed, '已恢复会话 archived')
    assert.deepEqual(calls.unarchiveSession, [{ sessionId: 'archived' }])
  })

  // --- schemas --------------------------------------------------------------

  test('manage tool schemas stay within the supported keyword subset for every policy', () => {
    const { ctx } = createCtx()
    const variants = [
      createSettings(),
      createSettings({
        session_update: { confirm: 'non-owned', targets: 'owned' },
        session_close: { confirm: 'always' },
        session_open: { confirm: 'non-owned' },
      }),
    ]

    for (const settings of variants) {
      for (const tool of createManageTools(ctx, settings)) {
        const label = tool.name
        assertSupportedSchema(tool.parameters, `${label}.parameters`)
        assertSupportedSchema(tool.output.schema, `${label}.output.schema`)
        for (const [name, schema] of Object.entries(parametersOf(tool).properties)) {
          assert.equal('minimum' in schema, false, `${label}.${name}: "minimum" is not supported`)
          assert.equal('maximum' in schema, false, `${label}.${name}: "maximum" is not supported`)
        }
      }
    }
  })

  test('the default manage schemas omit confirm', () => {
    const { ctx } = createCtx()
    const update = parametersOf(toolByName(ctx, 'session_update', {}))
    const close = parametersOf(toolByName(ctx, 'session_close', {}))
    const open = parametersOf(toolByName(ctx, 'session_open', {}))

    assert.deepEqual(update.required, ['session_id'])
    assert.deepEqual(close.required, ['session_id'])
    assert.deepEqual(open.required, ['session_id'])
    assert.equal('confirm' in update.properties, false)
    assert.equal('confirm' in close.properties, false)
    assert.equal('confirm' in open.properties, false)
  })

  test('a non-owned or always confirm policy declares confirm as a boolean', () => {
    const { ctx } = createCtx()
    const update = parametersOf(toolByName(ctx, 'session_update', { confirm: 'non-owned' }))
    const close = parametersOf(toolByName(ctx, 'session_close', { confirm: 'always' }))
    const open = parametersOf(toolByName(ctx, 'session_open', { confirm: 'always' }))

    assert.deepEqual(update.required, ['session_id'])
    assert.deepEqual(close.required, ['session_id'])
    assert.deepEqual(open.required, ['session_id'])
    assert.equal(update.properties.confirm?.type, 'boolean')
    assert.equal(close.properties.confirm?.type, 'boolean')
    assert.equal(open.properties.confirm?.type, 'boolean')
  })
})
