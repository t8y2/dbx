/**
 * Pure presentation logic for the collapsed reasoning-process char counter.
 *
 * Kept side-effect-free so it can be unit-tested without a DOM harness, matching
 * the existing pattern of `aiAgentStepPresentation.ts`. The AiAssistant template
 * consumes these helpers so its render decisions (show/hide, pulse class, text)
 * are covered by Vitest rather than only by the rendered template.
 */

/** Base CSS classes for the collapsed reasoning char counter span. */
export const REASONING_CHAR_COUNT_BASE_CLASS = "tabular-nums text-muted-foreground/60";

/** Extra class added while the model is still producing reasoning deltas. */
export const REASONING_CHAR_COUNT_PULSE_CLASS = "animate-pulse";

/**
 * Decide whether the collapsed reasoning char counter should render.
 * Visible only when there is reasoning text AND the panel is collapsed,
 * so the counter acts as a "still alive" heartbeat without forcing the
 * user to open the panel.
 *
 * @param reasoning  Accumulated reasoning text (may be empty during initial thinking).
 * @param expanded   Whether the reasoning panel is currently expanded.
 */
export function shouldShowReasoningCharCount(reasoning: string | undefined, expanded: boolean): boolean {
  return !expanded && !!reasoning && reasoning.length > 0;
}

/**
 * Return the CSS class string for the counter span.
 * Adds a pulse animation while the model is still thinking so the number
 * reads as actively growing rather than frozen.
 */
export function reasoningCharCountClass(isThinking: boolean): string {
  return isThinking ? `${REASONING_CHAR_COUNT_BASE_CLASS} ${REASONING_CHAR_COUNT_PULSE_CLASS}` : REASONING_CHAR_COUNT_BASE_CLASS;
}
