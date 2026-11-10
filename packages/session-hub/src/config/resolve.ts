/**
 * Resolve the raw plugin config into runtime settings.
 *
 * The host hands `apply` whatever the profile's `cordis.patch.yml` contains:
 * possibly absent, possibly the wrong shape, possibly one invalid field. The
 * resolver is total — it never throws — and every invalid value falls back to
 * the default of *that tool*, so one typo cannot silently weaken or widen a
 * different tool's policy.
 *
 * Two layers of defaults exist on purpose:
 *
 * - the schema defaults describe the generic policy (`limit: 30`, …);
 * - the per-tool defaults preserve the historical behaviour of each tool
 *   (`session_search.limit: 20`, `session_update.allowSelf: true`, …).
 *
 * A configured value is overlaid on the per-tool default only when it passed
 * schema validation. Numeric fields get a second check against the tool's own
 * operational bounds (for example, `session_search` can only return up to 50
 * hits even though the generic `limit` schema allows 200).
 */
import { ToolName } from '../shared/enums.js'
import {
  MAX_LIST_LIMIT,
  MAX_RECENT_MESSAGES,
  MAX_REPLY_MAX_CHARS,
  MAX_TIMEOUT_MS,
  MIN_LIST_LIMIT,
  MIN_RECENT_MESSAGES,
  MIN_REPLY_MAX_CHARS,
  MIN_TIMEOUT_MS,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MIN_LIMIT,
} from '../shared/limits.js'
import { Config, ToolPolicy } from './schema.js'

/** The validated shape of one tool policy (schema output type). */
export type ToolPolicyValues = ReturnType<typeof ToolPolicy>

/** One tool's fully resolved policy; every field is concrete. */
export type ResolvedToolPolicy = Readonly<ToolPolicyValues>

/** Read visibility of a session. */
export type ScopePolicy = ResolvedToolPolicy['scope']

/** Which targets a mutating tool may act on. */
export type TargetPolicy = ResolvedToolPolicy['targets']

/** When a mutating tool requires `confirm: true`. */
export type ConfirmPolicy = ResolvedToolPolicy['confirm']

/** How `session_wake` treats a running target. */
export type WhenRunningPolicy = ResolvedToolPolicy['whenRunning']

/** Whether `session_create` requires an initial task. */
export type TaskPolicy = ResolvedToolPolicy['task']

/** Where `session_create` may create a session. */
export type WorkspacePolicy = ResolvedToolPolicy['workspace']

/** Default status filter of `session_list`. */
export type StatusPolicy = ResolvedToolPolicy['status']

/** The resolved ownership settings. */
export interface ResolvedOwnership {
  readonly record: boolean
}

/**
 * The resolved allow/deny filters.
 *
 * An empty allow list means "no allow restriction". Deny always wins.
 */
export interface ResolvedFilters {
  readonly allowWorkspaces: readonly string[]
  readonly denyWorkspaces: readonly string[]
  readonly allowSessions: readonly string[]
  readonly denySessions: readonly string[]
}

/** Everything the tool layer needs, resolved once at `apply` time. */
export interface ResolvedSettings {
  readonly tools: Readonly<Record<ToolName, ResolvedToolPolicy>>
  readonly ownership: ResolvedOwnership
  readonly filters: ResolvedFilters
}

/** All tool names in the registration order used by the registry. */
const TOOL_NAMES: readonly ToolName[] = Object.values(ToolName)

/** Baseline policy: the schema defaults, shared by every tool. */
const BASE_TOOL_POLICY: ToolPolicyValues = ToolPolicy({})

/**
 * Per-tool deviations from the schema defaults.
 *
 * Only the two real differences are listed; every other field equals the
 * schema default. Keeping the table explicit makes the historical behaviour
 * reviewable in one place.
 */
const TOOL_OVERRIDES: Readonly<Record<ToolName, Partial<ResolvedToolPolicy>>> = {
  [ToolName.SessionList]: {},
  [ToolName.SessionGet]: {},
  [ToolName.SessionSearch]: { limit: SEARCH_DEFAULT_LIMIT },
  [ToolName.SessionCreate]: {},
  [ToolName.SessionUpdate]: { allowSelf: true },
  [ToolName.SessionClose]: {},
  [ToolName.SessionOpen]: {},
  [ToolName.SessionSend]: {},
  [ToolName.SessionWake]: {},
  [ToolName.SessionWait]: {},
}

/** Build one tool's default policy from the baseline plus its overrides. */
function defaultPolicy(name: ToolName): ResolvedToolPolicy {
  return Object.freeze({ ...BASE_TOOL_POLICY, ...TOOL_OVERRIDES[name] }) as ResolvedToolPolicy
}

/** The default policy of every tool, in registration order. */
export const DEFAULT_TOOL_POLICIES: Readonly<Record<ToolName, ResolvedToolPolicy>> =
  Object.freeze(
    Object.fromEntries(TOOL_NAMES.map((name) => [name, defaultPolicy(name)])) as Record<
      ToolName,
      ResolvedToolPolicy
    >,
  )

/** The default settings used when no config is present. */
export const DEFAULT_SETTINGS: ResolvedSettings = Object.freeze({
  tools: DEFAULT_TOOL_POLICIES,
  ownership: Object.freeze({ record: true }),
  filters: Object.freeze({
    allowWorkspaces: Object.freeze([]),
    denyWorkspaces: Object.freeze([]),
    allowSessions: Object.freeze([]),
    denySessions: Object.freeze([]),
  }),
})

/** Inclusive bounds of one numeric policy field. */
interface NumericBounds {
  readonly limit: readonly [number, number]
  readonly recent: readonly [number, number]
  readonly timeoutMaxMs: readonly [number, number]
  readonly replyMaxChars: readonly [number, number]
}

/** Build the bounds shared by every tool, with a tool-specific limit range. */
function numericBounds(limit: readonly [number, number]): NumericBounds {
  return {
    limit,
    recent: [MIN_RECENT_MESSAGES, MAX_RECENT_MESSAGES],
    timeoutMaxMs: [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS],
    replyMaxChars: [MIN_REPLY_MAX_CHARS, MAX_REPLY_MAX_CHARS],
  }
}

/** Operational bounds, which can be narrower than the generic schema. */
const LIST_BOUNDS = numericBounds([MIN_LIST_LIMIT, MAX_LIST_LIMIT])

const NUMERIC_BOUNDS: Readonly<Record<ToolName, NumericBounds>> = {
  [ToolName.SessionList]: LIST_BOUNDS,
  [ToolName.SessionGet]: LIST_BOUNDS,
  // The search backend is only asked for one bounded page.
  [ToolName.SessionSearch]: numericBounds([SEARCH_MIN_LIMIT, SEARCH_MAX_LIMIT]),
  [ToolName.SessionCreate]: LIST_BOUNDS,
  [ToolName.SessionUpdate]: LIST_BOUNDS,
  [ToolName.SessionClose]: LIST_BOUNDS,
  [ToolName.SessionOpen]: LIST_BOUNDS,
  [ToolName.SessionSend]: LIST_BOUNDS,
  [ToolName.SessionWake]: LIST_BOUNDS,
  [ToolName.SessionWait]: LIST_BOUNDS,
}

/**
 * Resolve the plugin config.
 *
 * Invalid values were already dropped from the (cloned) input by schemastery's
 * `autofix`, so this function only has to overlay the surviving keys on the
 * per-tool defaults and re-check the numeric bounds.
 */
export function resolveSettings(config?: unknown): ResolvedSettings {
  const parsed = parseConfig(config)
  const policies = {} as Record<ToolName, ResolvedToolPolicy>

  for (const name of TOOL_NAMES) {
    const merged = { ...DEFAULT_TOOL_POLICIES[name] } as ToolPolicyValues
    const provided = parsed.tools[name]
    if (isPlainRecord(provided)) {
      for (const key of Object.keys(provided)) {
        const value = provided[key]
        // A null/undefined field means "use the default" to schemastery; it is
        // not a value to copy over the per-tool default.
        if (key in merged && value !== undefined && value !== null) {
          ;(merged as unknown as Record<string, unknown>)[key] = value
        }
      }
    }

    const bounds = NUMERIC_BOUNDS[name]
    const defaults = DEFAULT_TOOL_POLICIES[name]
    merged.limit = pickInteger(merged.limit, bounds.limit, defaults.limit)
    merged.recent = pickInteger(merged.recent, bounds.recent, defaults.recent)
    merged.timeoutMaxMs = pickInteger(merged.timeoutMaxMs, bounds.timeoutMaxMs, defaults.timeoutMaxMs)
    merged.replyMaxChars = pickInteger(merged.replyMaxChars, bounds.replyMaxChars, defaults.replyMaxChars)

    policies[name] = Object.freeze(merged) as ResolvedToolPolicy
  }

  return Object.freeze({
    tools: Object.freeze(policies),
    ownership: Object.freeze({
      record: typeof parsed.ownership.record === 'boolean' ? parsed.ownership.record : true,
    }),
    filters: Object.freeze({
      allowWorkspaces: stringList(parsed.filters.allowWorkspaces),
      denyWorkspaces: stringList(parsed.filters.denyWorkspaces),
      allowSessions: stringList(parsed.filters.allowSessions),
      denySessions: stringList(parsed.filters.denySessions),
    }),
  })
}

/** Shapes read from the sanitized clone after `Config` validation. */
interface ParsedConfig {
  readonly tools: Record<string, unknown>
  readonly ownership: Record<string, unknown>
  readonly filters: Record<string, unknown>
}

/**
 * Validate a deep clone of the config and keep the sanitized tool objects.
 *
 * The clone is required because `autofix` deletes invalid keys from the object
 * it validates; mutating the host's config object would be a surprising side
 * effect of merely mounting the plugin.
 */
function parseConfig(config: unknown): ParsedConfig {
  const source = cloneValue(config)
  const record = isPlainRecord(source) ? source : {}
  try {
    Config(record, { autofix: true })
  } catch {
    // A non-plain or frozen input: nothing can be trusted, use defaults.
    return { tools: {}, ownership: {}, filters: {} }
  }

  return {
    tools: isPlainRecord(record.tools) ? record.tools : {},
    ownership: isPlainRecord(record.ownership) ? record.ownership : {},
    filters: isPlainRecord(record.filters) ? record.filters : {},
  }
}

/** Deep-copy plain objects and arrays; leave primitives and unknown values as-is. */
function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (isPlainRecord(value)) {
    const copy: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) copy[key] = cloneValue(child)
    return copy
  }
  return value
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keep an integral value inside `bounds`; otherwise return the tool default. */
function pickInteger(value: unknown, bounds: readonly [number, number], fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback
  const [min, max] = bounds
  return value >= min && value <= max ? value : fallback
}

/** Copy a validated string array, dropping anything that is not a string. */
function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([])
  return Object.freeze(value.filter((entry): entry is string => typeof entry === 'string'))
}
