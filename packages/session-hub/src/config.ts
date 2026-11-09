/**
 * Plugin configuration.
 *
 * The permission mode is fixed when the plugin is applied and decides which
 * authorization surface the mutating tools expose. It is read once from the
 * plugin config so every tool sees the same mode for the lifetime of the
 * plugin instance.
 */
import { PermissionMode } from './shared/enums.js'
import type { PermissionConfig } from './shared/types.js'

/** The permission mode used when the config is missing or invalid. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = PermissionMode.Permissive

/**
 * Resolve the configured permission mode.
 *
 * Only the exact string `owned` opts into ownership checks; everything else
 * (missing config, `undefined`, wrong case, unknown values) falls back to the
 * permissive default. This keeps an invalid config from silently narrowing or
 * widening permissions in a way the user did not ask for.
 *
 * The config crosses the plugin boundary untyped, so the read stays total:
 * optional chaining turns any non-object runtime value into the default
 * instead of throwing.
 */
export function resolvePermissionMode(config: PermissionConfig | undefined): PermissionMode {
  return config?.permissionMode === PermissionMode.Owned ? PermissionMode.Owned : DEFAULT_PERMISSION_MODE
}
