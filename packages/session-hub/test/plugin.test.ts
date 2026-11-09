import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { apply, inject, name } from '../src/index.js'

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

describe('plugin entry', () => {
  test('declares plugin identity', () => {
    assert.equal(name, 'session-hub')
    assert.deepEqual(inject, ['tools'])
  })

  test('apply tolerates a context without tools', () => {
    assert.doesNotThrow(() => apply({} as unknown as Context))
  })

  test('apply registers the read, create, manage and messaging tools', () => {
    const registered = register()

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
    for (const tool of registered) {
      assert.equal(typeof tool.execute, 'function')
      assert.equal(typeof tool.output.render, 'function')
    }
  })

  test('apply defaults to the permissive manage and messaging schemas', () => {
    const registered = register()
    const byName = (toolName: string): ToolDefinition => {
      const tool = registered.find((candidate) => candidate.name === toolName)
      assert.ok(tool !== undefined)
      return tool
    }

    assert.equal('confirm' in propertiesOf(byName('session_update')), false)
    assert.equal('confirm' in propertiesOf(byName('session_close')), false)
    assert.equal('confirm' in propertiesOf(byName('session_send')), false)
    assert.equal('confirm' in propertiesOf(byName('session_wake')), false)
    assert.equal('confirm' in propertiesOf(byName('session_wait')), false)
  })

  test('apply registers the owned schemas when permissionMode is "owned"', () => {
    const registered = register({ permissionMode: 'owned' })
    const byName = (toolName: string): ToolDefinition => {
      const tool = registered.find((candidate) => candidate.name === toolName)
      assert.ok(tool !== undefined)
      return tool
    }

    for (const toolName of ['session_update', 'session_close', 'session_send', 'session_wake']) {
      const confirm = propertiesOf(byName(toolName)).confirm as { readonly type?: unknown }
      assert.equal(confirm.type, 'boolean')
    }
    assert.equal('confirm' in propertiesOf(byName('session_wait')), false)
  })

  test('apply treats an invalid permissionMode as permissive', () => {
    for (const permissionMode of ['OWNED', 'admin', true]) {
      const registered = register({ permissionMode })
      const byName = (toolName: string): ToolDefinition => {
        const tool = registered.find((candidate) => candidate.name === toolName)
        assert.ok(tool !== undefined)
        return tool
      }

      for (const toolName of ['session_update', 'session_close', 'session_send', 'session_wake']) {
        assert.equal(
          'confirm' in propertiesOf(byName(toolName)),
          false,
          `${toolName} (${String(permissionMode)})`,
        )
      }
    }
  })
})
