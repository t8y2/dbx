import { afterEach, describe, expect, it, vi } from "vitest";
import { addConfiguredAiModel, aiModelOptions, generateId } from "@/lib/ai/aiConfigList";

describe("generateId", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses crypto.randomUUID when available", () => {
    const randomUUID = vi.fn(() => "123e4567-e89b-42d3-a456-426614174000");
    vi.stubGlobal("crypto", { randomUUID });

    expect(generateId()).toBe("123e4567-e89b-42d3-a456-426614174000");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("generates an id when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {});
    vi.spyOn(Math, "random").mockReturnValue(0);

    expect(generateId()).toBe("00000000-0000-4000-8000-000000000000");
  });
});

describe("AI model options", () => {
  it("keeps saved models selectable when provider model discovery fails", () => {
    const options = aiModelOptions(
      {
        model: "ark-code-latest",
        models: [{ name: "doubao-seed-2.0-code", label: "Doubao Code" }],
      },
      [],
    );

    expect(options).toEqual([
      { id: "ark-code-latest", displayName: undefined, supportedEffortLevels: undefined, effortCapability: undefined },
      { id: "doubao-seed-2.0-code", displayName: "Doubao Code", supportedEffortLevels: undefined, effortCapability: undefined },
    ]);
  });

  it("persists a manual model only once", () => {
    expect(addConfiguredAiModel([{ name: "ark-code-latest" }], "  doubao-seed-2.0-code  ")).toEqual([{ name: "ark-code-latest" }, { name: "doubao-seed-2.0-code" }]);
    expect(addConfiguredAiModel([{ name: "ark-code-latest" }], "ark-code-latest")).toEqual([{ name: "ark-code-latest" }]);
  });

  it("merges saved metadata with discovered capabilities", () => {
    const options = aiModelOptions(
      {
        model: "",
        models: [{ name: "gpt-4o", label: "GPT-4o", supportedEffortLevels: ["high"] }],
      },
      [{ id: "gpt-4o", displayName: "Discovered GPT-4o", effortCapability: { kind: "unsupported" } }],
    );

    expect(options).toEqual([{ id: "gpt-4o", displayName: "GPT-4o", supportedEffortLevels: ["high"], effortCapability: { kind: "unsupported" } }]);
  });

  it("handles an empty configured model and blank manual ids", () => {
    expect(aiModelOptions({ model: "", models: [{ name: "a-model" }] }, [])).toEqual([{ id: "a-model", displayName: undefined, supportedEffortLevels: undefined, effortCapability: undefined }]);
    expect(addConfiguredAiModel(undefined, "new-model")).toEqual([{ name: "new-model" }]);
    expect(addConfiguredAiModel([{ name: "existing" }], "   ")).toEqual([{ name: "existing" }]);
  });
});
