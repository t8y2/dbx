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

it("keeps smart matching for existing settings and rejects obsolete or invalid modes", () => {
  expect(normalizeEditorSettings({}).sidebarSearchMatchMode).toBe("fuzzy");
  for (const mode of ["edges", "invalid", null]) {
    expect(normalizeEditorSettings({ sidebarSearchMatchMode: mode as never }).sidebarSearchMatchMode).toBe("fuzzy");
  }
});

it("saves continuous matching and restores it in a new store", async () => {
  const store = useSettingsStore();
  await store.initEditorSettings();
  await store.updateEditorSettingsAndPersist({ sidebarSearchMatchMode: "contains" });
  const saved = backend.saveEditorSettings.mock.calls.at(-1)![0];
  expect(saved.sidebarSearchMatchMode).toBe("contains");
  backend.loadEditorSettings.mockResolvedValue(saved);
  setActivePinia(createPinia());
  const restored = useSettingsStore();
  await restored.initEditorSettings();
  expect(restored.editorSettings.sidebarSearchMatchMode).toBe("contains");
});

it("preserves a choice made while saved settings are still loading", async () => {
  let resolveLoad!: (value: unknown) => void;
  backend.loadEditorSettings.mockReturnValue(new Promise((resolve) => (resolveLoad = resolve)));
  const store = useSettingsStore();
  const loading = store.initEditorSettings();
  store.updateEditorSettings({ sidebarSearchMatchMode: "contains" });
  resolveLoad(DEFAULT_EDITOR_SETTINGS);
  await loading;
  await store.persistEditorSettings();
  expect(store.editorSettings.sidebarSearchMatchMode).toBe("contains");
  expect(backend.saveEditorSettings.mock.calls.at(-1)![0].sidebarSearchMatchMode).toBe("contains");
});
