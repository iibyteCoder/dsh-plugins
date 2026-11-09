/**
 * Error and failure text formatting.
 *
 * Two shapes exist because the plugin always had two:
 *
 * - errors with a stable, machine-readable code:
 *   `session-hub: <CODE>: <detail>`;
 * - plain validation/failure messages: `session-hub: <message>`.
 *
 * Both live here so no module hand-writes the `session-hub:` prefix.
 */
import { ErrorCode } from './enums.js'

const PREFIX = 'session-hub'

/** Render an error that carries a stable {@link ErrorCode}. */
export function sessionHubError(code: ErrorCode, detail: string): string {
  return `${PREFIX}: ${code}: ${detail}`
}

/** Render a failure message that has no stable code. */
export function sessionHubText(message: string): string {
  return `${PREFIX}: ${message}`
}

/** The message of an unknown thrown value, without the `Error: ` envelope. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Normalize a caught value into outward text.
 *
 * Values that already carry the plugin prefix are passed through unchanged;
 * everything else is prefixed, matching the tool wrappers' historical output.
 */
export function toErrorText(error: unknown): string {
  const message = errorMessage(error)
  return message.startsWith(`${PREFIX}: `) ? message : sessionHubText(message)
}
