import type { AiConfig, AiConfigItem, AiConfiguredModel } from "@/types/ai";
import type { AiModelInfo } from "@/lib/backend/tauri";
import { uuid } from "@/lib/common/utils";

export type { AiConfigItem };

export function generateId(): string {
  // Non-secure web deployments may expose crypto without randomUUID; the shared helper preserves a UUID-shaped fallback.
  return uuid();
}

export function getConfigKey(config: AiConfig): string {
  return `${config.provider}|${config.apiKey}|${config.endpoint}|${config.model}`;
}

/** Prepare imported configurations without overwriting existing entries. */
export function prepareImportedAiConfigs(existing: AiConfigItem[], imported: AiConfigItem[]): AiConfigItem[] {
  const existingKeys = new Set(existing.map(getConfigKey));
  const usedNames = new Set(existing.map((config) => config.name.trim().toLocaleLowerCase()));
  const prepared: AiConfigItem[] = [];

  for (const config of imported) {
    const key = getConfigKey(config);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);

    const originalName = config.name.trim() || "CC-SWITCH";
    let name = originalName;
    let suffix = 0;
    while (usedNames.has(name.toLocaleLowerCase())) {
      suffix += 1;
      name = `${originalName} (CC-SWITCH${suffix > 1 ? ` ${suffix}` : ""})`;
    }
    usedNames.add(name.toLocaleLowerCase());
    prepared.push({ ...config, name, isDefault: false });
  }

  return prepared;
}

export function aiConfigToItem(config: AiConfig, id: string, name: string): AiConfigItem {
  return {
    ...config,
    id,
    name,
  };
}

/**
 * Combines models saved by the user with models returned by a provider's
 * discovery endpoint. Some OpenAI-compatible providers intentionally do not
 * expose `/models`, so their saved models must remain selectable on their own.
 */
export function aiModelOptions(config: Pick<AiConfig, "model" | "models">, discovered: AiModelInfo[]): AiModelInfo[] {
  const saved: AiModelInfo[] = [
    config.model.trim() ? { id: config.model.trim() } : null,
    ...(config.models ?? []).map((model) => ({
      id: model.name.trim(),
      displayName: model.label?.trim() || undefined,
      supportedEffortLevels: model.supportedEffortLevels,
    })),
  ].filter((model): model is AiModelInfo => Boolean(model?.id));

  const options = new Map<string, AiModelInfo>();
  for (const model of [...saved, ...discovered]) {
    const id = model.id.trim();
    if (!id) continue;
    const existing = options.get(id);
    options.set(id, {
      ...model,
      id,
      displayName: existing?.displayName ?? model.displayName,
      supportedEffortLevels: existing?.supportedEffortLevels ?? model.supportedEffortLevels,
      effortCapability: model.effortCapability ?? existing?.effortCapability,
    });
  }
  return [...options.values()];
}

/** Add a manually entered model once while retaining its optional display metadata. */
export function addConfiguredAiModel(models: AiConfiguredModel[] | undefined, modelId: string): AiConfiguredModel[] {
  const id = modelId.trim();
  if (!id) return models ?? [];
  const existing = models ?? [];
  if (existing.some((model) => model.name.trim() === id)) return existing;
  return [...existing, { name: id }];
}

export type ConfigNameValidationResult = "empty" | "duplicate" | "valid";

export function validateConfigName(name: string, configs: AiConfigItem[], excludeId?: string): ConfigNameValidationResult {
  if (!name.trim()) return "empty";
  if (configs.some((c) => c.name.toLowerCase() === name.toLowerCase() && c.id !== excludeId)) {
    return "duplicate";
  }
  return "valid";
}
