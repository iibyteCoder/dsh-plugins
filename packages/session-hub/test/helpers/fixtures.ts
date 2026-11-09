/**
 * Shared fixtures for the migrated node:test suites.
 *
 * A single aggregate entry (`test/index.test.ts`) runs every suite in one
 * process, so each suite owns a temporary `DSH_HOME` and restores it in its
 * own `beforeEach`; module-level environment writes would otherwise leak
 * between suites.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import type { HostContext } from '../../src/shared/types.js'

export interface FakeExecAgent {
  readonly id?: string
  readonly session?: { readonly header?: { readonly cwd?: string } }
}

/** The execution-context subset the tests hand to a tool. */
export interface FakeExec {
  readonly agent?: FakeExecAgent
  readonly signal?: AbortSignal | undefined
}

/** Create a temporary directory usable as `DSH_HOME`. */
export function createTempHome(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** Remove a temporary home; safe to call twice. */
export function removeTempHome(home: string): void {
  fs.rmSync(home, { recursive: true, force: true })
}

/**
 * Augment a plain service bag with the host's `ctx.get(name)` accessor.
 *
 * The host resolves services through `ctx.get`, never through plain property
 * reads; mirroring that keeps these fixtures honest.
 */
export function serviceContext<T extends object>(services: T): T & HostContext {
  const get = (name: string): unknown => (services as Record<string, unknown>)[name]
  return Object.assign(services, { get }) as T & HostContext
}

/** Find a tool by name, failing loudly when it was not built. */
export function toolByName(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name)
  assert.ok(tool !== undefined, `missing tool "${name}"`)
  return tool
}

/** Execute one tool and return its outward text. */
export async function executeTool(
  tool: ToolDefinition,
  args: unknown,
  exec: FakeExec = { agent: { id: 'caller' } },
): Promise<string> {
  const value = await tool.execute(args, exec as unknown as ToolRunContext)
  assert.equal(typeof value, 'string')
  return value as string
}
