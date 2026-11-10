/**
 * Helpers for building resolved settings in tests.
 *
 * Tests never hand-build a `ResolvedSettings`: they describe the profile
 * config they care about and let the real resolver apply the defaults, so a
 * broken default is caught by the tool suites too.
 */
import { resolveSettings, type ResolvedSettings } from '../../src/config/resolve.js'
import type { ToolName } from '../../src/shared/enums.js'

/** Raw per-tool patches keyed by tool name. */
export type ToolPolicyPatches = Record<string, Readonly<Record<string, unknown>>>

/** Build resolved settings from a raw partial config. */
export function createSettings(
  tools: ToolPolicyPatches = {},
  extra: {
    readonly ownership?: Readonly<Record<string, unknown>>
    readonly filters?: Readonly<Record<string, unknown>>
  } = {},
): ResolvedSettings {
  return resolveSettings({ tools, ...extra })
}

/** Build settings that only override one tool. */
export function settingsFor(
  name: ToolName,
  patch: Readonly<Record<string, unknown>> = {},
): ResolvedSettings {
  return createSettings({ [name]: patch })
}
