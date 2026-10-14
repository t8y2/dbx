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
  const existingImportCounts = new Map<string, number>();
  for (const config of existing) {
    const key = getImportedConfigKey(config);
    existingImportCounts.set(key, (existingImportCounts.get(key) ?? 0) + 1);
  }
  const usedNames = new Set(existing.map((config) => config.name.trim().toLocaleLowerCase()));
  const prepared: AiConfigItem[] = [];

  for (const config of imported) {
    const key = getImportedConfigKey(config);
    const existingCount = existingImportCounts.get(key) ?? 0;
    if (existingCount > 0) {
      existingImportCounts.set(key, existingCount - 1);
      continue;
    }

    const originalName = config.name.trim() || "CC-SWITCH";
    let name = originalName;
    let suffix = 0;
    while (usedNames.has(name.toLocaleLowerCase())) {
      suffix += 1;
      name = `${originalName} (CC-SWITCH${suffix > 1 ? ` ${suffix}` : ""})`;
    }
    usedNames.add(name.toLocaleLowerCase());
    // Count the prepared entry so an exact duplicate later in the same batch is skipped.
    existingImportCounts.set(key, (existingImportCounts.get(key) ?? 0) + 1);
    prepared.push({ ...config, name, isDefault: false });
  }

  return prepared;
}

function getImportedConfigKey(config: AiConfigItem): string {
  // Keep distinct CC-SWITCH profiles even when their connection settings match.
  // Strip the suffix added below so importing the same profiles again is idempotent.
  const sourceName = (config.name.trim() || "CC-SWITCH").replace(/ \(CC-SWITCH(?: \d+)?\)$/i, "").toLocaleLowerCase();
  return `${getConfigKey(config)}|${sourceName}`;
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
