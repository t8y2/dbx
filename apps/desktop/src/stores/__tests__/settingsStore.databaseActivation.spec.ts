// @vitest-environment happy-dom
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_EDITOR_SETTINGS, normalizeEditorSettings, useSettingsStore } from "../settingsStore";

const backend = vi.hoisted(() => ({ loadEditorSettings: vi.fn(), saveEditorSettings: vi.fn() }));
vi.mock("@/lib/backend/api", () => backend);

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  setActivePinia(createPinia());
  backend.loadEditorSettings.mockResolvedValue(DEFAULT_EDITOR_SETTINGS);
  backend.saveEditorSettings.mockResolvedValue(undefined);
});

it("defaults database activation auto-expansion to on for new and existing settings", () => {
  expect(DEFAULT_EDITOR_SETTINGS.sidebarAutoExpandOnDatabaseActivation).toBe(true);
  expect(normalizeEditorSettings({ sidebarBrowseObjectsOnDatabaseActivation: true }).sidebarAutoExpandOnDatabaseActivation).toBe(true);
  for (const invalid of ["true", 1, null]) {
    expect(normalizeEditorSettings({ sidebarAutoExpandOnDatabaseActivation: invalid as never }).sidebarAutoExpandOnDatabaseActivation).toBe(true);
  }
});

it.each([true, false])("persists and restores auto-expansion %s independently from browsing objects", async (enabled) => {
  const store = useSettingsStore();
  await store.initEditorSettings();
  await store.updateEditorSettingsAndPersist({ sidebarAutoExpandOnDatabaseActivation: !enabled });
  await store.updateEditorSettingsAndPersist({ sidebarAutoExpandOnDatabaseActivation: enabled, sidebarBrowseObjectsOnDatabaseActivation: false });
  const saved = backend.saveEditorSettings.mock.calls.at(-1)![0];
  expect(saved.sidebarAutoExpandOnDatabaseActivation).toBe(enabled);
  backend.loadEditorSettings.mockResolvedValue(saved);
  setActivePinia(createPinia());
  const restored = useSettingsStore();
  await restored.initEditorSettings();
  expect(restored.editorSettings.sidebarAutoExpandOnDatabaseActivation).toBe(enabled);
  expect(restored.editorSettings.sidebarBrowseObjectsOnDatabaseActivation).toBe(false);
});
