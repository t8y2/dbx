/**
 * Context-aware AI prompts contributed by a plugin workbench.
 *
 * The host keeps the recommendation protocol deliberately small: a plugin
 * supplies display text, the prompt sent to the AI assistant, and an optional
 * order.  Values inside `{{path.to.value}}` placeholders are read from the
 * workbench context when recommendations are rendered.
 */

/** Maximum number of shortcut prompts shown by the AI assistant. */
export const MAX_PLUGIN_AI_RECOMMENDATIONS = 5;

/** JSON-like context supplied by a plugin for the active workbench resource. */
export type PluginAiRecommendationContext = Record<string, unknown>;

/** A declaration accepted by a plugin manifest or a runtime update. */
export interface PluginAiRecommendation {
  id: string;
  label: string;
  prompt: string;
  order?: number;
}

/** Runtime update sent by a workbench when its resource context changes. */
export interface PluginAiRecommendationUpdate {
  context: PluginAiRecommendationContext;
  items: readonly PluginAiRecommendation[];
}
