import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { apply, Config, inject, name } from '../src/index.js'

/** Mount the plugin on a minimal registrar and return what was registered. */
function register(config?: unknown): ToolDefinition[] {
  const registered: ToolDefinition[] = []
  const ctx = {
    tools: {
      register: (tool: ToolDefinition): (() => void) => {
        registered.push(tool)
        return () => {}
      },
    },
  }
  apply(ctx as unknown as Context, config)
  return registered
}

function propertiesOf(tool: ToolDefinition): Record<string, unknown> {
  return (tool.parameters as { readonly properties: Record<string, unknown> }).properties
}

function byName(tools: readonly ToolDefinition[], toolName: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === toolName)
  assert.ok(tool !== undefined, `missing tool "${toolName}"`)
  return tool
}

const ALL_TOOLS = [
  'session_list',
  'session_get',
  'session_create',
  'session_update',
  'session_close',
  'session_open',
  'session_send',
  'session_wake',
  'session_wait',
  'session_search',
]

describe('plugin entry', () => {
  test('declares plugin identity', () => {
    assert.equal(name, 'session-hub')
    assert.deepEqual(inject, ['tools'])
  })

  test('exports the schemastery config schema', () => {
    assert.equal(typeof Config, 'function')
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

  test('apply tolerates a context without tools', () => {
    assert.doesNotThrow(() => apply({} as unknown as Context))
  })

  test('apply registers the read, create, manage and messaging tools', () => {
    const registered = register()

    assert.deepEqual(
      registered.map((tool) => tool.name),
      ALL_TOOLS,
    )
    for (const tool of registered) {
      assert.equal(typeof tool.execute, 'function')
      assert.equal(typeof tool.output.render, 'function')
    }
  })

  test('apply registers nothing when every tool is disabled', () => {
    const tools = Object.fromEntries(ALL_TOOLS.map((toolName) => [toolName, { enabled: false }]))

    assert.deepEqual(register({ tools }), [])
  })

  test('enabled: false removes a tool from the registration surface', () => {
    const registered = register({
      tools: {
        session_list: { enabled: false },
        session_send: { enabled: false },
      },
    })

    assert.deepEqual(
      registered.map((tool) => tool.name),
      ALL_TOOLS.filter((toolName) => toolName !== 'session_list' && toolName !== 'session_send'),
    )
    assert.equal(registered.some((tool) => tool.name === 'session_list'), false)
  })

  test('every tool can be disabled individually', () => {
    for (const toolName of ALL_TOOLS) {
      const registered = register({ tools: { [toolName]: { enabled: false } } })
      assert.deepEqual(
        registered.map((tool) => tool.name),
        ALL_TOOLS.filter((candidate) => candidate !== toolName),
        toolName,
      )
    }
  })

  test('the default schemas omit confirm', () => {
    const registered = register()

    for (const toolName of ['session_update', 'session_close', 'session_open', 'session_send', 'session_wake', 'session_wait']) {
      assert.equal('confirm' in propertiesOf(byName(registered, toolName)), false, toolName)
    }
  })

  test('the confirm parameter appears only for a policy that can require it', () => {
    const registered = register({
      tools: {
        session_update: { confirm: 'non-owned' },
        session_close: { confirm: 'always' },
        session_open: { confirm: 'non-owned' },
        session_send: { confirm: 'always' },
        session_wake: { confirm: 'non-owned' },
      },
    })

    for (const toolName of ['session_update', 'session_close', 'session_open', 'session_send', 'session_wake']) {
      const confirm = propertiesOf(byName(registered, toolName)).confirm as { readonly type?: unknown }
      assert.equal(confirm.type, 'boolean', toolName)
    }
  })

  test('session_create hides title/model when the policy disables them', () => {
    const registered = register({
      tools: {
        session_create: { task: 'optional', allowTitle: false, allowModel: false },
      },
    })
    const tool = byName(registered, 'session_create')
    const parameters = tool.parameters as unknown as {
      readonly required: readonly string[]
      readonly properties: Record<string, unknown>
    }

    assert.deepEqual(parameters.required, [])
    assert.equal('title' in parameters.properties, false)
    assert.equal('model' in parameters.properties, false)
    assert.equal('provider' in parameters.properties, false)
    assert.equal('reasoning_effort' in parameters.properties, false)
  })

  test('an invalid config falls back to the defaults instead of failing', () => {
    for (const config of [{ tools: { session_list: { scope: 'bogus', limit: 0 } } }, { unknownOption: 'owned' }, 'nope', 42, null]) {
      const registered = register(config)
      assert.deepEqual(
        registered.map((tool) => tool.name),
        ALL_TOOLS,
        `config ${JSON.stringify(config)}`,
      )
    }
  })
})
