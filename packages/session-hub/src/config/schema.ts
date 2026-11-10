/**
 * The host-facing config schema.
 *
 * `Config` is the single source of truth for every knob the plugin accepts:
 * the profile's `cordis.patch.yml` is validated against it, and
 * `config/resolve.ts` derives the runtime settings from the same schema.
 *
 * `@deepseek-ai/schemastery` is provided by the DSH runtime resolution, so the
 * built plugin keeps one copy of the schema engine instead of bundling it.
 *
 * The exported interfaces spell out the schema output once. `declaration`
 * emit needs named types here: schemastery's inferred object types reference
 * cosmokit's `Dict`, which would leak into the plugin's `.d.ts`.
 */
import z from '@deepseek-ai/schemastery'

/** Validated output of one {@link ToolPolicy}. */
export interface ToolPolicyValues {
  enabled: boolean
  scope: 'all' | 'workspace' | 'owned'
  targets: 'owned' | 'any'
  confirm: 'never' | 'non-owned' | 'always'
  allowSelf: boolean
  allowArchived: boolean
  attribution: boolean
  whenRunning: 'steer' | 'queue'
  task: 'required' | 'optional'
  workspace: 'any' | 'same' | 'allowlist'
  allowTitle: boolean
  allowModel: boolean
  limit: number
  recent: number
  status: 'all' | 'running' | 'idle' | 'blank' | 'archived'
  timeoutMaxMs: number
  reply: boolean
  replyMaxChars: number
}

/** Validated output of {@link Config}. */
export interface ConfigValues {
  tools: Record<string, ToolPolicyValues>
  ownership: { record: boolean }
  filters: {
    allowWorkspaces: string[]
    denyWorkspaces: string[]
    allowSessions: string[]
    denySessions: string[]
  }
}

/** Policy applied to one tool; every field has a conservative default. */
export const ToolPolicy: Schemastery<any, ToolPolicyValues> = z.object({
  enabled: z.boolean().default(true),
  scope: z.union(['all', 'workspace', 'owned']).default('all'),
  targets: z.union(['owned', 'any']).default('any'),
  confirm: z.union(['never', 'non-owned', 'always']).default('never'),
  allowSelf: z.boolean().default(false),
  allowArchived: z.boolean().default(false),
  attribution: z.boolean().default(true),
  whenRunning: z.union(['steer', 'queue']).default('steer'),
  task: z.union(['required', 'optional']).default('required'),
  workspace: z.union(['any', 'same', 'allowlist']).default('any'),
  allowTitle: z.boolean().default(true),
  allowModel: z.boolean().default(true),
  limit: z.number().step(1).min(1).max(200).default(30),
  recent: z.number().step(1).min(0).max(50).default(10),
  status: z.union(['all', 'running', 'idle', 'blank', 'archived']).default('all'),
  timeoutMaxMs: z.number().step(1).min(1000).max(600000).default(120000),
  reply: z.boolean().default(true),
  replyMaxChars: z.number().step(1).min(1).max(10000).default(2000),
})

/** The whole plugin config; an absent field always falls back to its default. */
export const Config: Schemastery<any, ConfigValues> = z.object({
  tools: z.dict(ToolPolicy).default({}),
  ownership: z.object({ record: z.boolean().default(true) }).default({}),
  filters: z.object({
    allowWorkspaces: z.array(z.string()).default([]),
    denyWorkspaces: z.array(z.string()).default([]),
    allowSessions: z.array(z.string()).default([]),
    denySessions: z.array(z.string()).default([]),
  }).default({}),
})
