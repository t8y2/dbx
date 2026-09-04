/**
 * Progressive condensation for the per-group SQL editor toolbar.
 *
 * The tier is NOT derived from fixed width breakpoints — the control set
 * changes per database type, transaction state, and feature flags, so any
 * static guess would over- or under-condense. Instead the toolbar measures its
 * own row: while the content overflows the available width it steps up one
 * tier (moving controls into the overflow menu); it only steps back down when
 * there is real slack AND the pane has grown meaningfully since the last
 * condensation, so a static narrow layout can never oscillate.
 *
 * - Tier 0: full layout.
 * - Tier 1: secondary edit/entry actions (compress, keyword case, semantic
 *   diagnostics, open SQL, import archive, paste-in-condition, multi-execute)
 *   move into the overflow menu.
 * - Tier 2: format and the database helper buttons (clear / set-default) join
 *   the overflow menu.
 * - Tier 3: the explain-analyze toggle and the schema/catalog selectors leave
 *   the row; the row keeps execute, explain, save, transaction controls, the
 *   connection and database selectors (hard-truncated), and the overflow menu.
 */
export type EditorToolbarTier = 0 | 1 | 2 | 3;

export const EDITOR_TOOLBAR_MAX_TIER = 3;

/** Slack (px) required before giving a tier back — absorbs rendering jitter. */
export const EDITOR_TOOLBAR_STEP_DOWN_SLACK_PX = 48;
/** How much wider the pane must grow (px) vs the last condensation before stepping down. */
export const EDITOR_TOOLBAR_STEP_DOWN_MIN_GROWTH_PX = 64;

export interface EditorToolbarTierInput {
  tier: EditorToolbarTier;
  /** Measured inner width of the toolbar row. */
  availableWidth: number;
  /** Measured extent of the row's content (scrollWidth), including overflow. */
  contentWidth: number;
  /** Toolbar width when the current tier was condensed into; anchors step-down hysteresis. */
  condensedAtWidth?: number;
}

/**
 * Resolves the next toolbar tier from real measurements. Monotonic per
 * measurement — repeated calls after a tier change converge instead of
 * oscillating, because stepping down additionally requires the pane to have
 * grown by EDITOR_TOOLBAR_STEP_DOWN_MIN_GROWTH_PX since the last step up.
 */
export function resolveNextEditorToolbarTier(input: EditorToolbarTierInput): EditorToolbarTier {
  const { tier, availableWidth, contentWidth, condensedAtWidth = 0 } = input;
  if (!Number.isFinite(availableWidth) || !Number.isFinite(contentWidth) || availableWidth <= 0 || contentWidth <= 0) {
    // Unmeasured (first paint, hosts without ResizeObserver) keeps the current tier.
    return tier;
  }
  if (contentWidth > availableWidth && tier < EDITOR_TOOLBAR_MAX_TIER) {
    return (tier + 1) as EditorToolbarTier;
  }
  if (tier > 0 && availableWidth - contentWidth >= EDITOR_TOOLBAR_STEP_DOWN_SLACK_PX && availableWidth - condensedAtWidth >= EDITOR_TOOLBAR_STEP_DOWN_MIN_GROWTH_PX) {
    return (tier - 1) as EditorToolbarTier;
  }
  return tier;
}
