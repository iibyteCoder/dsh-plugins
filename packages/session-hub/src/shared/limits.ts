/**
 * Every numeric bound used by the plugin.
 *
 * Keeping the numbers here means pagination, truncation and timeout rules are
 * stated once and cannot drift between a schema description, a clamp and a
 * renderer.
 */

/** Default number of `session_list` rows. */
export const DEFAULT_LIST_LIMIT = 30

/** Smallest accepted `session_list` limit. */
export const MIN_LIST_LIMIT = 1

/** Largest accepted `session_list` limit. */
export const MAX_LIST_LIMIT = 200

/** Smallest accepted `session_get.include_recent`. */
export const MIN_RECENT_MESSAGES = 0

/** Largest accepted `session_get.include_recent`. */
export const MAX_RECENT_MESSAGES = 20

/** Longest single recent-message excerpt rendered by `session_get`. */
export const MAX_RECENT_MESSAGE_CHARS = 500

/** Longest assistant reply rendered by `session_wait`. */
export const MAX_REPLY_CHARS = 2000

/** Wait budget used when `timeout_ms` is missing or invalid. */
export const DEFAULT_TIMEOUT_MS = 120000

/** Smallest accepted wait budget. */
export const MIN_TIMEOUT_MS = 1000

/** Largest accepted wait budget. */
export const MAX_TIMEOUT_MS = 600000
