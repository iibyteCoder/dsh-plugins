/**
 * Readers for the calling agent carried by the tool execution context.
 *
 * Every tool needs the same two facts — who is calling and where its session
 * lives — so the narrowing lives here once instead of being re-implemented in
 * each tool factory.
 */
import type { ToolExecContext } from './types.js'

/** The calling session id, or `''` when the host did not expose one. */
export function callerIdOf(exec: ToolExecContext): string {
  return typeof exec.agent?.id === 'string' ? exec.agent.id.trim() : ''
}

/** The raw cwd of the calling session, or `''` when it is unknown. */
export function callerCwdOf(exec: ToolExecContext): string {
  const cwd = exec.agent?.session?.header?.cwd
  return typeof cwd === 'string' ? cwd.trim() : ''
}
