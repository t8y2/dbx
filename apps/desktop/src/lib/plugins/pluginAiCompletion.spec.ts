import { describe, expect, it, vi } from "vitest";
import { createPluginAiCompletion, pluginAiModels } from "./pluginAiCompletion";
import type { AiConfigItem } from "@/types/ai";
const config = { id: "one", name: "My AI", provider: "openai", authMethod: "api-key", apiStyle: "completions", model: "a", models: [{ name: "b" }], apiKey: "secret", endpoint: "private", customHeaders: { token: "secret" }, isDefault: true } as AiConfigItem;
describe("plugin text completion", () => {
  it("only exposes whitelisted metadata and excludes CLI agents", () => {
    const models = pluginAiModels([config, { ...config, id: "cli", provider: "codex-cli" }]);
    expect(models).toEqual([
      { configId: "one", name: "My AI", model: "a", isDefault: true },
      { configId: "one", name: "My AI", model: "b", isDefault: false },
    ]);
    expect(JSON.stringify(models)).not.toContain("secret");
  });
  it("generates consecutive requests without a confirmation callback and rejects unavailable providers", async () => {
    const complete = vi.fn().mockResolvedValue("done");
    const api = createPluginAiCompletion({ load: async () => [config, { ...config, id: "cli", provider: "codex-cli" }], complete });
    await expect(api.generateAiText("Plugin", { configId: "missing", model: "unknown", prompt: "hi" })).rejects.toThrow("no longer available");
    await expect(api.generateAiText("Plugin", { configId: "cli", model: "a", prompt: "hi" })).rejects.toThrow("no longer available");
    expect(complete).not.toHaveBeenCalled();
    for (const prompt of ["first", "second"]) {
      await expect(api.generateAiText("Plugin", { configId: "one", model: "b", prompt })).resolves.toBe("done");
    }
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it("resolves credentials only inside host and sanitizes provider errors", async () => {
    const complete = vi.fn().mockResolvedValue(" fix: example ");
    const api = createPluginAiCompletion({ load: async () => [config], complete });
    expect(await api.generateAiText("Plugin", { configId: "one", model: "b", prompt: "hi" })).toBe("fix: example");
    expect(complete.mock.calls[0][0].config).toMatchObject({ model: "b", apiKey: "secret" });
    complete.mockRejectedValue(new Error("secret"));
    await expect(api.generateAiText("Plugin", { configId: "one", model: "b", prompt: "hi" })).rejects.toThrow("AI generation failed");
  });
  it("lists empty providers, discovers models and accepts manual IDs without changing defaults", async () => {
    const empty = { ...config, model: "", models: [] };
    const complete = vi.fn().mockResolvedValue("done");
    const discover = vi.fn().mockResolvedValue([{ id: "remote", apiKey: "secret" }]);
    const api = createPluginAiCompletion({ load: async () => [empty], discover, complete });
    expect(await api.listAiProviders()).toEqual([{ configId: "one", name: "My AI" }]);
    expect(await api.discoverAiModels("one")).toEqual([{ configId: "one", name: "My AI", model: "remote", isDefault: false }]);
    await api.generateAiText("Plugin", { configId: "one", model: "manual", prompt: "hi" });
    expect(complete.mock.calls[0][0].config.model).toBe("manual");
    expect(empty.model).toBe("");
    discover.mockRejectedValue(new Error("secret endpoint"));
    await expect(api.discoverAiModels("one")).rejects.toThrow("Could not fetch models");
  });
  it("blocks concurrent requests and rejects empty or excessive results", async () => {
    let finish!: (s: string) => void;
    const complete = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const api = createPluginAiCompletion({ load: async () => [config], complete });
    const input = { configId: "one", model: "a", prompt: "hi" };
    const first = api.generateAiText("Plugin", input);
    await expect(api.generateAiText("Plugin", input)).rejects.toThrow("already generating");
    await vi.waitFor(() => expect(complete).toHaveBeenCalled());
    finish("");
    await expect(first).rejects.toThrow("empty");
    complete.mockResolvedValue("x".repeat(16001));
    await expect(api.generateAiText("Plugin", input)).rejects.toThrow("16000");
  });
});
