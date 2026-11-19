import type { AiConfigItem } from "@/types/ai";

export interface AiImportDraft {
  config: AiConfigItem;
  selected: boolean;
  defaultModel: string;
  selectable: boolean;
  disabledReason?: string;
}

export function normalizeAiImportSourceConfigs(configs: AiConfigItem[], sourceName: "CC-SWITCH" | "Magpie"): AiConfigItem[] {
  if (sourceName !== "Magpie") return configs;

  // The current importer uses Magpie's active Codex model only when the
  // provider offers it. Clear unmatched values left by older plugin versions.
  return configs.map((config) => ({
    ...config,
    model: config.models?.some((model) => model.name.trim() === config.model.trim()) ? config.model : "",
  }));
}

export function createAiImportDrafts(configs: AiConfigItem[], importableIds?: ReadonlySet<string>): AiImportDraft[] {
  return configs.map((config) => ({
    config,
    selected: importableIds == null || importableIds.has(config.id),
    defaultModel: config.model.trim(),
    selectable: importableIds == null || importableIds.has(config.id),
    disabledReason: importableIds != null && !importableIds.has(config.id) ? "alreadyImported" : undefined,
  }));
}

export function aiImportSelectableModels(draft: AiImportDraft): Array<{ value: string; label: string }> {
  const configuredModels = (draft.config.models ?? [])
    .map((model) => ({
      value: model.name.trim(),
      label: model.label?.trim() || model.name.trim(),
    }))
    .filter((model) => model.value);
  const models = [...configuredModels];
  const defaultModel = draft.config.model.trim();
  if (defaultModel && !models.some((model) => model.value === defaultModel)) {
    models.unshift({ value: defaultModel, label: defaultModel });
  }
  return models;
}

export function selectedAiImportConfigs(drafts: AiImportDraft[]): AiConfigItem[] {
  return drafts
    .filter((draft) => draft.selectable && draft.selected)
    .map(({ config, defaultModel }) => ({
      ...config,
      model: defaultModel.trim(),
      isDefault: false,
    }));
}
