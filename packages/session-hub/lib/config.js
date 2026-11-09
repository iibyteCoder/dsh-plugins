/**
 * Plugin configuration.
 *
 * The permission mode is fixed when the plugin is applied and decides which
 * authorization surface the mutating tools expose. It is read once from the
 * plugin config so every tool sees the same mode for the lifetime of the
 * plugin instance.
 */

/** The permission mode used when the config is missing or invalid. */
export const DEFAULT_PERMISSION_MODE = 'permissive'

/**
 * Resolve the configured permission mode.
 *
 * Only the exact string `'owned'` opts into ownership checks; everything else
 * (missing config, `undefined`, wrong case, unknown values) falls back to the
 * permissive default. This keeps an invalid config from silently narrowing or
 * widening permissions in a way the user did not ask for.
 *
 * @param {{permissionMode?: unknown}} [config] - Plugin config from `apply`.
 * @returns {'permissive' | 'owned'}
 */
export function resolvePermissionMode(config) {
  return config?.permissionMode === 'owned' ? 'owned' : DEFAULT_PERMISSION_MODE
}
