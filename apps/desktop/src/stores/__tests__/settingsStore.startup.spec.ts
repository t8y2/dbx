// @vitest-environment happy-dom

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../settingsStore";

const backend = vi.hoisted(() => ({
  loadAiConfigs: vi.fn(),
  loadAiChatSelection: vi.fn(),
  loadAiConfig: vi.fn(),
  loadAiProviderConfigs: vi.fn(),
  saveAiChatSelection: vi.fn(),
}));
vi.mock("@/lib/backend/api", () => backend);

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  setActivePinia(createPinia());
  backend.loadAiChatSelection.mockResolvedValue(null);
  backend.loadAiConfig.mockResolvedValue(null);
  backend.loadAiProviderConfigs.mockResolvedValue(null);
});

describe("AI startup initialization", () => {
  it("shares pending initialization between startup and the AI panel", async () => {
    let resolveConfigs!: (configs: []) => void;
    backend.loadAiConfigs.mockImplementation(
      () =>
        new Promise<[]>((resolve) => {
          resolveConfigs = resolve;
        }),
    );
    const store = useSettingsStore();
    const first = store.initAiConfigs();
    const second = store.initAiConfigs();
    expect(backend.loadAiConfigs).toHaveBeenCalledTimes(1);
    expect(store.isAiConfigLoaded).toBe(false);
    resolveConfigs([]);
    await Promise.all([first, second]);
    expect(store.isAiConfigLoaded).toBe(true);
    expect(backend.loadAiChatSelection).toHaveBeenCalledTimes(1);
    await store.initAiConfigs();
    expect(backend.loadAiConfigs).toHaveBeenCalledTimes(1);
  });

  it("permits retry after a shared initialization failure", async () => {
    backend.loadAiConfigs.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue([]);
    const store = useSettingsStore();
    const pending = [store.initAiConfigs(), store.initAiConfigs()];
    const results = await Promise.allSettled(pending);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(store.isAiConfigLoaded).toBe(false);
    await store.initAiConfigs();
    expect(backend.loadAiConfigs).toHaveBeenCalledTimes(2);
    expect(store.isAiConfigLoaded).toBe(true);
  });
});
