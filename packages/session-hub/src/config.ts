/**
 * Plugin configuration.
 *
 * The permission mode is fixed when the plugin is applied and decides which
 * authorization surface the mutating tools expose. It is read once from the
 * plugin config so every tool sees the same mode for the lifetime of the
 * plugin instance.
 */
import { PermissionMode } from './shared/enums.js'

/** The permission mode used when the config is missing or invalid. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = PermissionMode.Permissive

/**
 * Resolve the configured permission mode.
 *
 * Only the exact string `owned` opts into ownership checks; everything else
 * (missing config, `undefined`, wrong case, unknown values) falls back to the
 * permissive default. This keeps an invalid config from silently narrowing or
 * widening permissions in a way the user did not ask for.
 */
export function resolvePermissionMode(config?: unknown): PermissionMode {
  if (typeof config !== 'object' || config === null) return DEFAULT_PERMISSION_MODE
  const value = (config as { readonly permissionMode?: unknown }).permissionMode
  return value === PermissionMode.Owned ? PermissionMode.Owned : DEFAULT_PERMISSION_MODE
}
