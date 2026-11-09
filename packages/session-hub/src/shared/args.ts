/**
 * Safe readers for decoded tool arguments.
 *
 * Tool arguments arrive as `unknown`; these helpers are the single place that
 * turns them into strings, numbers and records. They never throw on a
 * malformed value, matching the plugin's textual-failure policy.
 */
import type { ToolArgs } from './types.js'

/** Narrow a decoded argument value to a plain record. */
export function asToolArgs(value: unknown): ToolArgs {
  return typeof value === 'object' && value !== null ? (value as ToolArgs) : {}
}

/** A trimmed string, or `''` for any non-string/blank value. */
export function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Read one trimmed string argument. */
export function stringArg(args: ToolArgs, key: string): string {
  return nonEmptyString(args[key])
}

/**
 * Clamp an integer argument into `[min, max]`.
 *
 * Missing, blank and non-finite values fall back to `fallback`; the bounds are
 * applied after truncation so a fractional input stays integral.
 */
export function integerOption(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'number' && !Number.isFinite(value)) return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** Stringify a value for display, keeping `null`/`undefined` as `-`. */
export function textOrDash(value: unknown): string {
  return value === undefined || value === null ? '-' : String(value)
}
