/**
 * Shared authorization and model-selection logic for the session tools.
 *
 * Ownership lives in the plugin's own index (`lib/owner-index.js`); the host
 * services are only an execution surface. Keeping the rules in one module
 * means `session_update`, `session_close`, and `session_create` cannot drift
 * apart on who may act on a session or how a model is resolved.
 */
import { readOwnerIndex } from './owner-index.js'

/**
 * Read the owner session id of a session.
 *
 * A missing entry, a malformed entry, or an unusable input yields `''`, which
 * every caller treats as "not owned by the caller" — unknown ownership must
 * never silently grant permission.
 *
 * @param {string} sessionId
 * @returns {Promise<string>}
 */
export async function ownerOf(sessionId) {
  const id = nonEmptyString(sessionId)
  if (id === '') return ''
  const owners = await readOwnerIndex()
  const owner = owners[id]?.ownerSessionId
  return typeof owner === 'string' ? owner : ''
}

/**
 * Decide whether an operation on a target session needs explicit confirmation.
 *
 * `session_update` needs confirmation unless the caller owns the target.
 * `session_close` additionally needs confirmation when the target is the
 * calling session itself; the caller passes that fact through
 * `selfRequiresConfirm`.
 *
 * @param {string} ownerId - Owner session id of the target (`''` when unknown).
 * @param {string} callerId - Session id of the caller (`''` when unavailable).
 * @param {{selfRequiresConfirm?: boolean}} [options]
 * @returns {boolean}
 */
export function confirmRequired(ownerId, callerId, { selfRequiresConfirm = false } = {}) {
  const owner = nonEmptyString(ownerId)
  const caller = nonEmptyString(callerId)

  // Unknown ownership, or ownership by a different session, always needs
  // confirmation. Only "the caller created this target" can be exempt, and
  // even then the caller may opt into confirmation (closing itself).
  const ownedByCaller = owner !== '' && owner === caller
  if (!ownedByCaller) return true
  return selfRequiresConfirm === true
}

/**
 * Fixed authorization failure text shared by the mutating tools.
 *
 * @param {string} sessionId
 * @returns {string}
 */
export function confirmError(sessionId) {
  return `session-hub: CONFIRM_REQUIRED: session "${sessionId}" is not owned by the calling session`
}

/**
 * Resolve the arguments of a model change into a `selectModel` request.
 *
 * Rules:
 * - no model arguments at all → `null` (nothing to do);
 * - a model without a provider → look it up in the model catalog and accept
 *   the sole provider that offers it;
 * - an unknown or ambiguous model, or a catalog failure → `{ error }`.
 *
 * @param {object} controller - Host session controller.
 * @param {{provider?: string, model?: string, reasoning_effort?: string}} [args]
 * @returns {Promise<{selection: {provider: string, model: string, reasoningEffort?: string}} | {error: string} | null>}
 */
export async function resolveModelSelection(controller, args = {}) {
  const provider = nonEmptyString(args?.provider)
  const model = nonEmptyString(args?.model)
  const reasoningEffort = nonEmptyString(args?.reasoning_effort)

  if (provider === '' && model === '' && reasoningEffort === '') return null
  if (model === '' && reasoningEffort !== '') {
    return { error: 'session-hub: reasoning_effort requires model' }
  }
  if (model === '' && provider !== '') {
    return { error: 'session-hub: provider requires model' }
  }

  if (provider !== '') {
    return { selection: buildSelection(provider, model, reasoningEffort) }
  }

  let catalog
  try {
    catalog = await controller.modelCatalog()
  } catch (error) {
    return { error: `session-hub: model catalog unavailable: ${errorMessage(error)}` }
  }

  const providers = providersForModel(catalog, model)
  if (providers.length === 0) {
    return { error: `session-hub: model "${model}" is not routable` }
  }
  if (providers.length > 1) {
    return {
      error: `session-hub: model "${model}" is offered by multiple providers; pass provider`,
    }
  }
  return { selection: buildSelection(providers[0], model, reasoningEffort) }
}

/**
 * @param {string} provider
 * @param {string} model
 * @param {string} reasoningEffort
 * @returns {{provider: string, model: string, reasoningEffort?: string}}
 */
function buildSelection(provider, model, reasoningEffort) {
  const selection = { provider, model }
  if (reasoningEffort !== '') selection.reasoningEffort = reasoningEffort
  return selection
}

/**
 * Collect the distinct provider ids whose catalog group offers `model`.
 *
 * @param {unknown} catalog
 * @param {string} model
 * @returns {string[]}
 */
function providersForModel(catalog, model) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
  const providers = []
  for (const group of groups) {
    const provider = nonEmptyString(group?.id)
    if (provider === '' || providers.includes(provider)) continue
    const models = Array.isArray(group?.models) ? group.models : []
    if (models.some((candidate) => candidate?.id === model)) providers.push(provider)
  }
  return providers
}

function nonEmptyString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
