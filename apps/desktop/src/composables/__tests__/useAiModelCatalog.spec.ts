import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConfigItem, AiEffortCapability } from "@/types/ai";

const apiMock = vi.hoisted(() => ({
  aiListModels: vi.fn(),
  aiResolveModelEffort: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => apiMock);

import { useAiModelCatalog } from "@/composables/useAiModelCatalog";

function config(id = "config-1"): AiConfigItem {
  return {
    id,
    name: "OpenAI",
    isDefault: true,
    provider: "openai",
    apiKey: "secret",
    authMethod: "bearer",
    endpoint: "https://api.example.com/v1",
    model: "",
    apiStyle: "responses",
  };
}

describe("useAiModelCatalog", () => {
  const catalog = useAiModelCatalog();

  beforeEach(() => {
    catalog.catalogs.clear();
    catalog.effortCatalogs.clear();
    apiMock.aiListModels.mockReset();
    apiMock.aiResolveModelEffort.mockReset();
  });

  it("deduplicates concurrent model requests and removes duplicate model IDs", async () => {
    apiMock.aiListModels.mockResolvedValue([
      { id: "gpt-5.6", displayName: "GPT 5.6" },
      { id: "gpt-5.6", displayName: "Duplicate" },
    ]);

    const [first, second] = await Promise.all([catalog.loadModels(config()), catalog.loadModels(config())]);

    expect(apiMock.aiListModels).toHaveBeenCalledTimes(1);
    expect(first).toEqual([{ id: "gpt-5.6", displayName: "GPT 5.6" }]);
    expect(second).toEqual(first);
    expect(catalog.catalogs.get("config-1")?.status).toBe("ready");
  });

  it("reuses effort capability returned with the model catalog", async () => {
    const capability: AiEffortCapability = {
      kind: "enum",
      options: [{ id: "low", label: "Low", selection: { kind: "enum", value: "low" } }],
      default: { kind: "enum", value: "low" },
      source: "providerApi",
    };
    apiMock.aiListModels.mockResolvedValue([{ id: "claude-model", effortCapability: capability }]);

    await catalog.loadModels(config());
    const resolved = await catalog.resolveEffort(config(), "claude-model");

    expect(resolved).toEqual(capability);
    expect(apiMock.aiResolveModelEffort).not.toHaveBeenCalled();
  });

  it("keeps a provider failure scoped and allows an explicit retry", async () => {
    apiMock.aiListModels.mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValueOnce([{ id: "recovered" }]);

    await expect(catalog.loadModels(config())).rejects.toThrow("temporary failure");
    expect(catalog.catalogs.get("config-1")).toMatchObject({ status: "error", error: "temporary failure" });

    await expect(catalog.loadModels(config(), true)).resolves.toEqual([{ id: "recovered" }]);
    expect(apiMock.aiListModels).toHaveBeenCalledTimes(2);
  });

  it("invalidates model and effort caches when provider runtime configuration changes", async () => {
    const initial = config();
    const updated = { ...initial, endpoint: "https://api.changed.example.com/v1" };
    apiMock.aiListModels.mockResolvedValueOnce([{ id: "old-model" }]).mockResolvedValueOnce([{ id: "new-model" }]);
    apiMock.aiResolveModelEffort.mockResolvedValueOnce({ kind: "unsupported" }).mockResolvedValueOnce({
      kind: "enum",
      options: [{ id: "high", label: "High", selection: { kind: "enum", value: "high" } }],
      default: { kind: "enum", value: "high" },
      source: "providerApi",
    });

    await expect(catalog.loadModels(initial)).resolves.toEqual([{ id: "old-model" }]);
    await expect(catalog.resolveEffort(initial, "manual-model")).resolves.toEqual({ kind: "unsupported" });
    await expect(catalog.loadModels(updated)).resolves.toEqual([{ id: "new-model" }]);
    await expect(catalog.resolveEffort(updated, "manual-model")).resolves.toMatchObject({ kind: "enum" });

    expect(apiMock.aiListModels).toHaveBeenCalledTimes(2);
    expect(apiMock.aiResolveModelEffort).toHaveBeenCalledTimes(2);
  });

  it("tracks OpenCode executable and environment changes without depending on environment key order", async () => {
    const initial: AiConfigItem = {
      ...config(),
      provider: "opencode-cli",
      endpoint: "",
      apiKey: "",
      model: "default",
      opencodeCliPath: "/opt/homebrew/bin/opencode",
      opencodeCliEnv: { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "localhost" },
    };
    apiMock.aiListModels.mockResolvedValueOnce([{ id: "first" }]).mockResolvedValueOnce([{ id: "second" }]);

    await expect(catalog.loadModels(initial)).resolves.toEqual([{ id: "first" }]);
    await expect(
      catalog.loadModels({
        ...initial,
        opencodeCliEnv: { NO_PROXY: "localhost", HTTPS_PROXY: "http://127.0.0.1:7890" },
      }),
    ).resolves.toEqual([{ id: "first" }]);
    await expect(catalog.loadModels({ ...initial, opencodeCliPath: "/usr/local/bin/opencode" })).resolves.toEqual([{ id: "second" }]);

    expect(apiMock.aiListModels).toHaveBeenCalledTimes(2);
  });

  it("tracks Cursor executable and environment changes without depending on environment key order", async () => {
    const initial: AiConfigItem = {
      ...config(),
      provider: "cursor-cli",
      endpoint: "",
      apiKey: "",
      model: "default",
      cursorCliPath: "~/.local/bin/agent",
      cursorCliEnv: { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "localhost" },
    };
    apiMock.aiListModels.mockResolvedValueOnce([{ id: "first" }]).mockResolvedValueOnce([{ id: "second" }]);

    await expect(catalog.loadModels(initial)).resolves.toEqual([{ id: "first" }]);
    await expect(
      catalog.loadModels({
        ...initial,
        cursorCliEnv: { NO_PROXY: "localhost", HTTPS_PROXY: "http://127.0.0.1:7890" },
      }),
    ).resolves.toEqual([{ id: "first" }]);
    await expect(catalog.loadModels({ ...initial, cursorCliPath: "/usr/local/bin/agent" })).resolves.toEqual([{ id: "second" }]);

    expect(apiMock.aiListModels).toHaveBeenCalledTimes(2);
  });

  it("tracks CodeBuddy executable and environment changes without depending on environment key order", async () => {
    const initial: AiConfigItem = {
      ...config(),
      provider: "codebuddy-cli",
      endpoint: "",
      apiKey: "",
      model: "default",
      codebuddyCliPath: "/opt/homebrew/bin/codebuddy",
      codebuddyCliEnv: { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "localhost" },
    };
    apiMock.aiListModels.mockResolvedValueOnce([{ id: "first" }]).mockResolvedValueOnce([{ id: "second" }]);

    await expect(catalog.loadModels(initial)).resolves.toEqual([{ id: "first" }]);
    await expect(
      catalog.loadModels({
        ...initial,
        codebuddyCliEnv: { NO_PROXY: "localhost", HTTPS_PROXY: "http://127.0.0.1:7890" },
      }),
    ).resolves.toEqual([{ id: "first" }]);
    await expect(catalog.loadModels({ ...initial, codebuddyCliPath: "/usr/local/bin/codebuddy" })).resolves.toEqual([{ id: "second" }]);

    expect(apiMock.aiListModels).toHaveBeenCalledTimes(2);
  });

  it("tracks Qoder executable and environment changes without depending on environment key order", async () => {
    const initial: AiConfigItem = {
      ...config(),
      provider: "qoder-cli",
      endpoint: "",
      apiKey: "",
      model: "default",
      qoderCliPath: "/opt/homebrew/bin/qodercli",
      qoderCliEnv: { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "localhost" },
    };
    apiMock.aiListModels.mockResolvedValueOnce([{ id: "first" }]).mockResolvedValueOnce([{ id: "second" }]);

    await expect(catalog.loadModels(initial)).resolves.toEqual([{ id: "first" }]);
    await expect(
      catalog.loadModels({
        ...initial,
        qoderCliEnv: { NO_PROXY: "localhost", HTTPS_PROXY: "http://127.0.0.1:7890" },
      }),
    ).resolves.toEqual([{ id: "first" }]);
    await expect(catalog.loadModels({ ...initial, qoderCliPath: "/usr/local/bin/qodercli" })).resolves.toEqual([{ id: "second" }]);

    expect(apiMock.aiListModels).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale request overwrite a newer provider catalog", async () => {
    let resolveInitial: ((models: { id: string }[]) => void) | undefined;
    apiMock.aiListModels
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveInitial = resolve;
        }),
      )
      .mockResolvedValueOnce([{ id: "new-model" }]);

    const initialRequest = catalog.loadModels(config());
    const updatedRequest = catalog.loadModels({ ...config(), endpoint: "https://api.changed.example.com/v1" });
    await expect(updatedRequest).resolves.toEqual([{ id: "new-model" }]);
    resolveInitial?.([{ id: "old-model" }]);
    await expect(initialRequest).resolves.toEqual([{ id: "old-model" }]);

    expect(catalog.catalogs.get("config-1")?.models).toEqual([{ id: "new-model" }]);
  });
});
