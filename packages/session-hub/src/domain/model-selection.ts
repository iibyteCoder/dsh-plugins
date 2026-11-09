/**
 * Model-selection resolution.
 *
 * The host can select a model by provider + id, or look it up in its catalog.
 * The rules are stated once here so `session_create` and `session_update`
 * cannot disagree about when a request is incomplete, ambiguous or unknown.
 */
import type { ModelCatalog, ModelCatalogModel, SessionController } from '../host/contracts.js'
import { nonEmptyString } from '../shared/args.js'
import { errorMessage, sessionHubText } from '../shared/errors.js'
import type {
  ModelSelection,
  ModelSelectionArgs,
  ModelSelectionOutcome,
} from '../shared/types.js'

/**
 * Resolve the arguments of a model change into a `selectModel` request.
 *
 * Rules:
 * - no model arguments at all → `null` (nothing to do);
 * - a model without a provider → look it up in the model catalog and accept
 *   the sole provider that offers it;
 * - an unknown or ambiguous model, or a catalog failure → `{ error }`.
 */
export async function resolveModelSelection(
  controller: SessionController,
  args: ModelSelectionArgs,
): Promise<ModelSelectionOutcome> {
  const provider = nonEmptyString(args.provider)
  const model = nonEmptyString(args.model)
  const reasoningEffort = nonEmptyString(args.reasoning_effort)

  if (provider === '' && model === '' && reasoningEffort === '') return null
  if (model === '' && reasoningEffort !== '') {
    return { error: sessionHubText('reasoning_effort requires model') }
  }
  if (model === '' && provider !== '') {
    return { error: sessionHubText('provider requires model') }
  }

  if (provider !== '') {
    return { selection: buildSelection(provider, model, reasoningEffort) }
  }

  let catalog: ModelCatalog | undefined
  try {
    catalog = await controller.modelCatalog()
  } catch (error) {
    return { error: sessionHubText(`model catalog unavailable: ${errorMessage(error)}`) }
  }

  const providers = providersForModel(catalog, model)
  if (providers.length === 0) {
    return { error: sessionHubText(`model "${model}" is not routable`) }
  }
  if (providers.length > 1) {
    return {
      error: sessionHubText(`model "${model}" is offered by multiple providers; pass provider`),
    }
  }
  return { selection: buildSelection(providers[0] ?? '', model, reasoningEffort) }
}

function buildSelection(provider: string, model: string, reasoningEffort: string): ModelSelection {
  return reasoningEffort === ''
    ? { provider, model }
    : { provider, model, reasoningEffort }
}

/** Collect the distinct provider ids whose catalog group offers `model`. */
function providersForModel(catalog: ModelCatalog | undefined, model: string): string[] {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
  const providers: string[] = []
  for (const group of groups) {
    const provider = nonEmptyString(group?.id)
    if (provider === '' || providers.includes(provider)) continue
    const models: readonly ModelCatalogModel[] = Array.isArray(group?.models)
      ? group.models
      : []
    if (models.some((candidate) => candidate?.id === model)) providers.push(provider)
  }
  return providers
}
