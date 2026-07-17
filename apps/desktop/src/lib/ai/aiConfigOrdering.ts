import { AI_PROVIDER_PRESETS } from "@/stores/settingsStore";
import type { AiProvider } from "@/types/ai";

const AI_PROVIDER_DISPLAY_RANK = new Map<AiProvider, number>((Object.keys(AI_PROVIDER_PRESETS) as AiProvider[]).map((provider, index) => [provider, index]));

/**
 * Match configured-provider lists to the canonical provider picker order while
 * preserving creation order between configs that use the same provider.
 */
export function orderAiConfigsForDisplay<T extends { provider: AiProvider }>(configs: readonly T[]): T[] {
  return configs
    .map((config, index) => ({ config, index }))
    .sort((a, b) => (AI_PROVIDER_DISPLAY_RANK.get(a.config.provider) ?? Number.MAX_SAFE_INTEGER) - (AI_PROVIDER_DISPLAY_RANK.get(b.config.provider) ?? Number.MAX_SAFE_INTEGER) || a.index - b.index)
    .map(({ config }) => config);
}
