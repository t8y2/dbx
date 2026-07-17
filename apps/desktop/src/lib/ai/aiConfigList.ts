import type { AiConfig, AiConfigItem } from "@/types/ai";

export type { AiConfigItem };

export function generateId(): string {
  return crypto.randomUUID();
}

export function getConfigKey(config: AiConfig): string {
  return `${config.provider}|${config.apiKey}|${config.endpoint}|${config.model}`;
}

export function aiConfigToItem(config: AiConfig, id: string, name: string): AiConfigItem {
  return {
    ...config,
    id,
    name,
  };
}

export type ConfigNameValidationResult = "empty" | "duplicate" | "valid";

export function validateConfigName(name: string, configs: AiConfigItem[], excludeId?: string): ConfigNameValidationResult {
  if (!name.trim()) return "empty";
  if (configs.some((c) => c.name.toLowerCase() === name.toLowerCase() && c.id !== excludeId)) {
    return "duplicate";
  }
  return "valid";
}
