import { describe, expect, it } from "vitest";
import { aiImportSelectableModels, createAiImportDrafts, normalizeAiImportSourceConfigs, selectedAiImportConfigs } from "@/lib/ai/aiImportSelection";
import type { AiConfigItem } from "@/types/ai";

function config(overrides: Partial<AiConfigItem> = {}): AiConfigItem {
  return {
    id: "magpie-1",
    name: "Magpie Gateway",
    provider: "openai-compatible",
    apiKey: "dummy-key",
    authMethod: "bearer",
    endpoint: "https://example.invalid/v1",
    model: "",
    models: [{ name: "model-b" }, { name: "model-a", label: "Model A" }],
    apiStyle: "completions",
    isDefault: false,
    ...overrides,
  };
}

describe("AI config import selection", () => {
  it("keeps the default model unset when the source provides only a model list", () => {
    const [draft] = createAiImportDrafts([config()]);

    expect(draft.defaultModel).toBe("");
    expect(aiImportSelectableModels(draft)).toEqual([
      { value: "model-b", label: "model-b" },
      { value: "model-a", label: "Model A" },
    ]);
  });

  it("clears an unmatched Magpie model while retaining its model list", () => {
    const [normalized] = normalizeAiImportSourceConfigs([config({ model: "fixture-model" })], "Magpie");
    const [draft] = createAiImportDrafts([normalized]);

    expect(draft.defaultModel).toBe("");
    expect(aiImportSelectableModels(draft).map((model) => model.value)).toEqual(["model-b", "model-a"]);
  });

  it("preserves the active Magpie model when it exists in the imported model list", () => {
    const [normalized] = normalizeAiImportSourceConfigs([config({ model: "model-a" })], "Magpie");
    const [draft] = createAiImportDrafts([normalized]);

    expect(draft.defaultModel).toBe("model-a");
  });

  it("preserves the source default model for CC-SWITCH", () => {
    const [normalized] = normalizeAiImportSourceConfigs([config({ model: "ccswitch-model" })], "CC-SWITCH");

    expect(normalized.model).toBe("ccswitch-model");
  });

  it("offers an explicit source model even when it is missing from the model list", () => {
    const [draft] = createAiImportDrafts([config({ model: "source-default", models: [{ name: "other-model" }] })]);

    expect(aiImportSelectableModels(draft)).toEqual([
      { value: "source-default", label: "source-default" },
      { value: "other-model", label: "other-model" },
    ]);
  });

  it("returns only checked configs and applies the selected default model", () => {
    const drafts = createAiImportDrafts([config(), config({ id: "magpie-2", name: "Second Gateway" })]);
    drafts[0].defaultModel = "model-a";
    drafts[1].selected = false;

    expect(selectedAiImportConfigs(drafts)).toEqual([
      expect.objectContaining({
        id: "magpie-1",
        model: "model-a",
        isDefault: false,
      }),
    ]);
  });

  it("keeps already imported configs visible but disabled", () => {
    const drafts = createAiImportDrafts([config(), config({ id: "magpie-2", name: "Existing Gateway" })], new Set(["magpie-1"]));
    drafts[1].selected = true;

    expect(drafts[1]).toMatchObject({
      selectable: false,
      selected: true,
      disabledReason: "alreadyImported",
    });
    expect(selectedAiImportConfigs(drafts)).toEqual([expect.objectContaining({ id: "magpie-1" })]);
  });
});
