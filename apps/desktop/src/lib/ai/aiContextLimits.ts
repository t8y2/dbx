/**
 * Single source of truth for every AI context budget.
 *
 * The values started out as module-local constants in `aiAttachments.ts` and
 * `aiExternalContext.ts`. They are centralized here so a future user-facing
 * setting can override the overridable dimensions through one resolver instead
 * of editing scattered magic numbers. Phase 1 only moves the values: the
 * defaults below reproduce the previous behavior exactly.
 *
 * Keep this module dependency-free. `aiAttachments` and `aiExternalContext`
 * both import it, so importing either of them back would create a cycle.
 */

export const QUERY_RESULT_BUDGET_HEADROOM_CHARS = 400;

export const AI_CONTEXT_DEFAULTS = {
  textAttachmentMaxBytes: 48 * 1024,
  textAttachmentMaxChars: 12_000,
  textAttachmentMaxCount: 8,
  textAttachmentMaxTotalChars: 32_000,
  imageAttachmentMaxBytes: 5 * 1024 * 1024,
  imageAttachmentMaxCount: 4,
  imageAttachmentMaxTotalBytes: 12 * 1024 * 1024,
  selectionMaxChars: 12_000,
  selectionMaxCount: 8,
  selectionTotalChars: 32_000,
  queryResultMaxRows: 30,
} as const;

/**
 * Detail caps for the query-result preview. These are not part of the
 * overridable surface: they bound pathological column names, values and single
 * wide rows well below the content budget, so a future setting only needs to
 * change the budget and row cap, not each of these.
 */
export const AI_QUERY_RESULT_PREVIEW_LIMITS = {
  maxValueChars: 200,
  maxSqlChars: 4_000,
  maxColumnChars: 200,
  columnBudgetChars: 2_000,
  maxLineChars: 1_200,
  maxRowLabelChars: 100,
  reservedTailChars: 200,
} as const;

/**
 * Upper bound for the dimensions a future setting may override. Clamping here
 * means a persisted value can never turn into an unbounded request payload.
 */
export const AI_CONTEXT_HARD_CAPS = {
  selectionMaxChars: 32_000,
  selectionMaxCount: 16,
  selectionTotalChars: 64_000,
  queryResultMaxRows: 200,
} as const;

export interface AiContextLimitOverrides {
  selectionMaxChars?: number;
  selectionMaxCount?: number;
  selectionTotalChars?: number;
  queryResultMaxRows?: number;
}

export interface AiContextLimits {
  selectionMaxChars: number;
  selectionMaxCount: number;
  selectionTotalChars: number;
  queryResultMaxRows: number;
  /** Derived, never overridden directly: the preview always leaves headroom for its footer. */
  queryResultBudgetChars: number;
}

function resolveLimit(value: number | undefined, fallback: number, hardCap: number): number {
  // A persisted override is untrusted input: non-finite or negative values are
  // treated as absent rather than silently clamped to the minimum, which would
  // turn a corrupt setting into "attach almost nothing".
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.min(hardCap, Math.max(1, Math.floor(value)));
}

/** Resolve the overridable dimensions, clamping them into the hard caps. */
export function resolveAiContextLimits(overrides: AiContextLimitOverrides = {}): AiContextLimits {
  const selectionMaxChars = resolveLimit(overrides.selectionMaxChars, AI_CONTEXT_DEFAULTS.selectionMaxChars, AI_CONTEXT_HARD_CAPS.selectionMaxChars);
  return {
    selectionMaxChars,
    selectionMaxCount: resolveLimit(overrides.selectionMaxCount, AI_CONTEXT_DEFAULTS.selectionMaxCount, AI_CONTEXT_HARD_CAPS.selectionMaxCount),
    selectionTotalChars: resolveLimit(overrides.selectionTotalChars, AI_CONTEXT_DEFAULTS.selectionTotalChars, AI_CONTEXT_HARD_CAPS.selectionTotalChars),
    queryResultMaxRows: resolveLimit(overrides.queryResultMaxRows, AI_CONTEXT_DEFAULTS.queryResultMaxRows, AI_CONTEXT_HARD_CAPS.queryResultMaxRows),
    queryResultBudgetChars: Math.max(1, selectionMaxChars - QUERY_RESULT_BUDGET_HEADROOM_CHARS),
  };
}
