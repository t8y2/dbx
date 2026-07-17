import { test } from "vitest";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  saveAiConfigItem: vi.fn<[unknown]>().mockResolvedValue(undefined),
  deleteAiConfig: vi.fn<[string]>().mockResolvedValue(undefined),
  setDefaultAiConfig: vi.fn<[string]>().mockResolvedValue(undefined),
  loadAiConfigs: vi.fn<[]>().mockResolvedValue([]),
  saveAiConfigs: vi.fn<[unknown[]]>().mockResolvedValue(undefined),
  loadEditorSettings: vi.fn<[]>().mockResolvedValue(null),
  saveEditorSettings: vi.fn<[unknown]>().mockResolvedValue(undefined),
  loadDesktopSettings: vi.fn<[]>().mockResolvedValue(null),
}));

vi.mock("@/lib/backend/api", () => apiMock);

import { useSettingsStore } from "../../apps/desktop/src/stores/settingsStore.ts";

test("createAiConfig rejects -> state unchanged", async () => {
  setActivePinia(createPinia());
  apiMock.saveAiConfigItem.mockRejectedValueOnce(new Error("db error"));

  const store = useSettingsStore();
  await assert.rejects(
    () => store.createAiConfig({ id: "c1", name: "test", isDefault: false } as any),
    /db error/,
  );
  assert.equal(store.aiConfigs.length, 0);
});

test("deleteAiConfig rejects -> state unchanged", async () => {
  setActivePinia(createPinia());
  const store = useSettingsStore();
  store.aiConfigs.push({ id: "c1", name: "a", isDefault: true } as any);
  store.aiConfigs.push({ id: "c2", name: "b", isDefault: false } as any);

  apiMock.deleteAiConfig.mockRejectedValueOnce(new Error("db error"));
  await assert.rejects(() => store.deleteAiConfig("c1"), /db error/);
  assert.equal(store.aiConfigs.length, 2);
});

test("updateAiConfigItem rejects -> state unchanged", async () => {
  setActivePinia(createPinia());
  const store = useSettingsStore();
  store.aiConfigs.push({ id: "c1", name: "old", config: {} } as any);

  apiMock.saveAiConfigItem.mockRejectedValueOnce(new Error("db error"));
  await assert.rejects(() => store.updateAiConfigItem("c1", { name: "new" }), /db error/);
  assert.equal(store.aiConfigs[0].name, "old");
});

test("setDefaultAiConfig rejects -> isDefault unchanged", async () => {
  setActivePinia(createPinia());
  const store = useSettingsStore();
  store.aiConfigs.push({ id: "c1", name: "a", isDefault: true } as any);
  store.aiConfigs.push({ id: "c2", name: "b", isDefault: false } as any);

  apiMock.setDefaultAiConfig.mockRejectedValueOnce(new Error("db error"));
  await assert.rejects(() => store.setDefaultAiConfig("c2"), /db error/);
  assert.ok(store.aiConfigs.find((c: any) => c.id === "c1")!.isDefault);
  assert.ok(!store.aiConfigs.find((c: any) => c.id === "c2")!.isDefault);
});

test("createAiConfig succeeds -> state reflects new config", async () => {
  setActivePinia(createPinia());
  const store = useSettingsStore();
  await store.createAiConfig({ id: "c1", name: "t", model: "m", config: {} } as any);
  assert.equal(store.aiConfigs.length, 1);
  assert.equal(store.aiConfigs[0].id, "c1");
});

test("updateAiConfigItem succeeds -> state updated", async () => {
  setActivePinia(createPinia());
  const store = useSettingsStore();
  store.aiConfigs.push({ id: "c1", name: "old", config: {} } as any);
  await store.updateAiConfigItem("c1", { name: "new" });
  assert.equal(store.aiConfigs[0].name, "new");
});

test("deleteAiConfig succeeds -> state reflects deletion", async () => {
  setActivePinia(createPinia());
  const store = useSettingsStore();
  store.aiConfigs.push({ id: "c1", name: "a" } as any);
  await store.deleteAiConfig("c1");
  assert.equal(store.aiConfigs.length, 0);
});

test("setDefaultAiConfig succeeds -> isDefault flipped", async () => {
  setActivePinia(createPinia());
  const store = useSettingsStore();
  store.aiConfigs.push({ id: "c1", name: "a", isDefault: true } as any);
  store.aiConfigs.push({ id: "c2", name: "b", isDefault: false } as any);

  await store.setDefaultAiConfig("c2");
  assert.ok(!store.aiConfigs.find((c: any) => c.id === "c1")!.isDefault);
  assert.ok(store.aiConfigs.find((c: any) => c.id === "c2")!.isDefault);
});

test("reloadAiConfigs resets and reloads from API", async () => {
  setActivePinia(createPinia());
  const store = useSettingsStore();
  store.aiConfigs.push({ id: "old", name: "stale", isDefault: true } as any);

  apiMock.loadAiConfigs.mockResolvedValueOnce([
    { id: "fresh", name: "fresh", isDefault: true } as any,
  ]);

  await store.reloadAiConfigs();
  assert.equal(store.aiConfigs.length, 1);
  assert.equal(store.aiConfigs[0].id, "fresh");
  assert.equal(store.activeModel?.configId, "fresh");
});

test("reloadAiConfigs falls back when active config was deleted", async () => {
  setActivePinia(createPinia());
  const store = useSettingsStore();

  // Simulate post-sync: activeModel points to a config no longer in ai_configs
  store.aiConfigs.push({ id: "remaining", name: "r", model: "m", isDefault: true } as any);
  store.activeModel = { configId: "deleted", modelId: "gone" };

  apiMock.loadAiConfigs.mockResolvedValueOnce([
    { id: "remaining", name: "r", model: "m", isDefault: true } as any,
  ]);

  await store.reloadAiConfigs();
  assert.equal(store.aiConfigs.length, 1);
  // activeModel should fall back to the first (and only) remaining config
  assert.equal(store.activeModel?.configId, "remaining");
});
