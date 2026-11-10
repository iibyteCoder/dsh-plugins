import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { ToolPolicyValues } from '../src/config/schema.js'
import { Config, ToolPolicy } from '../src/config/schema.js'
import {
  DEFAULT_SETTINGS,
  DEFAULT_TOOL_POLICIES,
  resolveSettings,
} from '../src/config/resolve.js'
import { ToolName } from '../src/shared/enums.js'

/** The generic, schema-level defaults. */
const SCHEMA_DEFAULTS: ToolPolicyValues = {
  enabled: true,
  scope: 'all',
  targets: 'any',
  confirm: 'never',
  allowSelf: false,
  allowArchived: false,
  attribution: true,
  whenRunning: 'steer',
  task: 'required',
  workspace: 'any',
  allowTitle: true,
  allowModel: true,
  limit: 30,
  recent: 10,
  status: 'all',
  timeoutMaxMs: 120000,
  reply: true,
  replyMaxChars: 2000,
}

/**
 * Per-tool defaults that must not drift from the tools' historical behaviour.
 * Only fields that matter for the tool are listed; everything else is the
 * generic default.
 */
const EXPECTED_DEFAULTS: readonly (readonly [ToolName, Partial<ToolPolicyValues>])[] = [
  [ToolName.SessionList, { enabled: true, scope: 'all', limit: 30, status: 'all' }],
  [ToolName.SessionGet, { enabled: true, scope: 'all', recent: 10, limit: 30 }],
  [ToolName.SessionSearch, { enabled: true, scope: 'all', limit: 20 }],
  [
    ToolName.SessionCreate,
    { enabled: true, task: 'required', workspace: 'any', allowTitle: true, allowModel: true },
  ],
  [ToolName.SessionUpdate, { enabled: true, targets: 'any', confirm: 'never', allowSelf: true }],
  [ToolName.SessionClose, { enabled: true, targets: 'any', confirm: 'never', allowSelf: false }],
  [ToolName.SessionOpen, { enabled: true, targets: 'any', confirm: 'never' }],
  [
    ToolName.SessionSend,
    {
      enabled: true,
      targets: 'any',
      confirm: 'never',
      allowSelf: false,
      allowArchived: false,
      attribution: true,
    },
  ],
  [
    ToolName.SessionWake,
    {
      enabled: true,
      targets: 'any',
      confirm: 'never',
      allowSelf: false,
      allowArchived: false,
      whenRunning: 'steer',
      attribution: true,
    },
  ],
  [
    ToolName.SessionWait,
    { enabled: true, timeoutMaxMs: 120000, reply: true, replyMaxChars: 2000 },
  ],
]

describe('config', () => {
  test('the schemastery schema exposes the documented defaults', () => {
    assert.deepEqual(ToolPolicy({}), SCHEMA_DEFAULTS)
    assert.deepEqual(Config({}), {
      tools: {},
      ownership: { record: true },
      filters: {
        allowWorkspaces: [],
        denyWorkspaces: [],
        allowSessions: [],
        denySessions: [],
      },
    })
  })

  test('every tool starts from its documented default', () => {
    for (const [name, expected] of EXPECTED_DEFAULTS) {
      const policy = DEFAULT_TOOL_POLICIES[name]
      for (const [field, value] of Object.entries(expected)) {
        assert.equal(
          (policy as unknown as Record<string, unknown>)[field],
          value,
          `${name}.${field}`,
        )
      }
    }
  })

  test('tools that share the generic policy stay on the schema defaults', () => {
    for (const name of [ToolName.SessionList, ToolName.SessionGet, ToolName.SessionClose, ToolName.SessionOpen]) {
      const policy = DEFAULT_TOOL_POLICIES[name]
      // The per-tool override table only changes what the tool actually uses.
      assert.equal(policy.allowArchived, false, `${name}.allowArchived`)
      assert.equal(policy.whenRunning, 'steer', `${name}.whenRunning`)
      assert.equal(policy.replyMaxChars, 2000, `${name}.replyMaxChars`)
    }
  })

  test('resolving nothing yields the same settings as the exported defaults', () => {
    assert.deepEqual(resolveSettings(undefined), DEFAULT_SETTINGS)
    assert.deepEqual(resolveSettings(null), DEFAULT_SETTINGS)
    assert.deepEqual(resolveSettings({}), DEFAULT_SETTINGS)
  })

  test('configured values override only the fields they name', () => {
    const settings = resolveSettings({
      tools: {
        session_list: { scope: 'owned', limit: 5, status: 'idle' },
        session_send: { confirm: 'always', allowSelf: true, attribution: false },
        session_wait: { reply: false, replyMaxChars: 100, timeoutMaxMs: 5000 },
      },
    })

    assert.equal(settings.tools[ToolName.SessionList].scope, 'owned')
    assert.equal(settings.tools[ToolName.SessionList].limit, 5)
    assert.equal(settings.tools[ToolName.SessionList].status, 'idle')
    // Untouched sibling fields keep their defaults.
    assert.equal(settings.tools[ToolName.SessionList].recent, 10)
    assert.equal(settings.tools[ToolName.SessionGet].scope, 'all')

    assert.equal(settings.tools[ToolName.SessionSend].confirm, 'always')
    assert.equal(settings.tools[ToolName.SessionSend].allowSelf, true)
    assert.equal(settings.tools[ToolName.SessionSend].attribution, false)
    assert.equal(settings.tools[ToolName.SessionSend].allowArchived, false)

    assert.equal(settings.tools[ToolName.SessionWait].reply, false)
    assert.equal(settings.tools[ToolName.SessionWait].replyMaxChars, 100)
    assert.equal(settings.tools[ToolName.SessionWait].timeoutMaxMs, 5000)
  })

  test('the dict merge keeps every tool independent', () => {
    const settings = resolveSettings({
      tools: {
        session_search: { limit: 7 },
        session_update: { allowSelf: false, targets: 'owned' },
        not_a_tool: { enabled: false },
      },
    })

    assert.equal(settings.tools[ToolName.SessionSearch].limit, 7)
    assert.equal(settings.tools[ToolName.SessionUpdate].allowSelf, false)
    assert.equal(settings.tools[ToolName.SessionUpdate].targets, 'owned')
    // An unknown tool key is ignored instead of creating a policy.
    assert.deepEqual(
      Object.keys(settings.tools).sort(),
      Object.values(ToolName).sort(),
    )
  })

  test('invalid values fall back to the default of that field', () => {
    const settings = resolveSettings({
      tools: {
        session_list: { limit: 0, status: 'archived' },
        session_get: { recent: 51 },
        session_search: { scope: 'bogus' },
        session_wake: { confirm: 'sometimes', whenRunning: 'later', attribution: 'no' },
        session_wait: { timeoutMaxMs: 999, replyMaxChars: 0, reply: 'yes' },
        session_create: { workspace: 'everywhere', task: 'maybe', allowTitle: 'yes' },
        session_send: { enabled: 'yes', allowArchived: 1 },
      },
    })

    // Invalid fields fall back, valid siblings survive.
    assert.equal(settings.tools[ToolName.SessionList].limit, 30)
    assert.equal(settings.tools[ToolName.SessionList].status, 'archived')
    assert.equal(settings.tools[ToolName.SessionGet].recent, 10)
    assert.equal(settings.tools[ToolName.SessionSearch].scope, 'all')
    assert.equal(settings.tools[ToolName.SessionWake].confirm, 'never')
    assert.equal(settings.tools[ToolName.SessionWake].whenRunning, 'steer')
    assert.equal(settings.tools[ToolName.SessionWake].attribution, true)
    assert.equal(settings.tools[ToolName.SessionWait].timeoutMaxMs, 120000)
    assert.equal(settings.tools[ToolName.SessionWait].replyMaxChars, 2000)
    assert.equal(settings.tools[ToolName.SessionWait].reply, true)
    assert.equal(settings.tools[ToolName.SessionCreate].workspace, 'any')
    assert.equal(settings.tools[ToolName.SessionCreate].task, 'required')
    assert.equal(settings.tools[ToolName.SessionCreate].allowTitle, true)
    assert.equal(settings.tools[ToolName.SessionSend].enabled, true)
    assert.equal(settings.tools[ToolName.SessionSend].allowArchived, false)
  })

  test('numeric values are cross-checked against tool bounds', () => {
    const settings = resolveSettings({
      tools: {
        session_search: { limit: 200 },
        session_list: { limit: 500 },
        session_get: { recent: 50 },
        session_wait: { timeoutMaxMs: 999999, replyMaxChars: 10000 },
      },
    })

    // 200 is a valid generic limit but the search backend only returns one page.
    assert.equal(settings.tools[ToolName.SessionSearch].limit, 20)
    assert.equal(settings.tools[ToolName.SessionList].limit, 30)
    // 50 is the maximum accepted recent count, not a fallback.
    assert.equal(settings.tools[ToolName.SessionGet].recent, 50)
    assert.equal(settings.tools[ToolName.SessionWait].timeoutMaxMs, 120000)
    assert.equal(settings.tools[ToolName.SessionWait].replyMaxChars, 10000)
  })

  test('null and undefined fields mean "use the default"', () => {
    const settings = resolveSettings({
      tools: {
        session_list: { enabled: null, scope: undefined, limit: null, status: undefined },
        session_search: { limit: null },
      },
      ownership: { record: null },
      filters: { denySessions: null },
    })

    assert.equal(settings.tools[ToolName.SessionList].enabled, true)
    assert.equal(settings.tools[ToolName.SessionList].scope, 'all')
    assert.equal(settings.tools[ToolName.SessionList].limit, 30)
    assert.equal(settings.tools[ToolName.SessionList].status, 'all')
    assert.equal(settings.tools[ToolName.SessionSearch].limit, 20)
    assert.deepEqual(settings.ownership, { record: true })
    assert.deepEqual(settings.filters.denySessions, [])
  })

  test('a malformed tool entry is ignored instead of failing the config', () => {
    for (const value of ['yes', 1, true, [], null]) {
      const settings = resolveSettings({ tools: { session_list: value } })
      assert.deepEqual(settings.tools[ToolName.SessionList], DEFAULT_TOOL_POLICIES[ToolName.SessionList])
    }
  })

  test('non-object configs degrade to the defaults without throwing', () => {
    for (const config of [null, undefined, 0, 'owned', true, [], () => {}]) {
      assert.deepEqual(resolveSettings(config), DEFAULT_SETTINGS)
    }
  })

  test('the host config object is never mutated by validation', () => {
    const config = {
      tools: {
        session_list: { limit: 0, scope: 'bogus' },
        session_send: { confirm: 'always' },
      },
      ownership: { record: false },
      filters: { denySessions: ['x'] },
    }
    const snapshot = structuredClone(config)

    resolveSettings(config)

    assert.deepEqual(config, snapshot)
  })

  test('ownership and filters are resolved independently', () => {
    const settings = resolveSettings({
      ownership: { record: false },
      filters: {
        allowWorkspaces: ['Alpha'],
        denyWorkspaces: ['Beta'],
        allowSessions: ['s1'],
        denySessions: ['s2', 3],
      },
    })

    assert.deepEqual(settings.ownership, { record: false })
    assert.deepEqual(settings.filters, {
      allowWorkspaces: ['Alpha'],
      denyWorkspaces: ['Beta'],
      allowSessions: ['s1'],
      denySessions: ['s2'],
    })
  })

  test('invalid ownership and filter shapes fall back to the defaults', () => {
    for (const ownership of ['no', 1, []]) {
      assert.deepEqual(resolveSettings({ ownership }).ownership, { record: true })
    }
    for (const filters of ['no', 1, []]) {
      assert.deepEqual(resolveSettings({ filters }).filters, DEFAULT_SETTINGS.filters)
    }
  })
})
