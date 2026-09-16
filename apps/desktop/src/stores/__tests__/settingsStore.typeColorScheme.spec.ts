import { createPinia, setActivePinia } from "pinia";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const saved: unknown[] = [];

vi.mock("@/lib/backend/api", () => ({
  saveEditorSettings: vi.fn(async (settings: unknown) => {
    saved.push(JSON.parse(JSON.stringify(settings)));
  }),
  loadEditorSettings: vi.fn(async () => null),
  loadDesktopSettings: vi.fn(async () => null),
  saveDesktopSettings: vi.fn(async () => {}),
}));

const SCHEME = {
  id: "type-colors-1",
  name: "配色方案 1",
  colors: { integer: "#254fce", numeric: "#0e7490", string: "#fdc9c9", boolean: "#100cc2", temporal: "#7e22ce", structured: "#be185d", identifier: "#92400e", binary: "#b91c1c", spatial: "#047857" },
};

describe("settings store type color scheme persistence", () => {
  beforeEach(() => {
    saved.length = 0;
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    setActivePinia(createPinia());
  });

  it("keeps a committed scheme in memory", async () => {
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();

    store.updateEditorSettings({ dataGridTypeColorSchemes: [SCHEME], activeDataGridTypeColorSchemeId: SCHEME.id });

    expect(store.editorSettings.dataGridTypeColorSchemes).toHaveLength(1);
    expect(store.editorSettings.activeDataGridTypeColorSchemeId).toBe(SCHEME.id);
  });

  it("writes the scheme through to the persistence layer", async () => {
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();
    await store.persistEditorSettings();
    saved.length = 0;

    store.updateEditorSettings({ dataGridTypeColorSchemes: [SCHEME], activeDataGridTypeColorSchemeId: SCHEME.id });
    await store.persistEditorSettings();

    const last = saved.at(-1) as Record<string, unknown> | undefined;
    expect(last?.dataGridTypeColorSchemes).toEqual([SCHEME]);
    expect(last?.activeDataGridTypeColorSchemeId).toBe(SCHEME.id);
  });

  it("persists a scheme committed before the store finished loading", async () => {
    // The scheme dialog can commit before anything has awaited initEditorSettings.
    // A plain updateEditorSettings only lands in memory there, so the colors show
    // up and then vanish on the next reload; the persisting variant must be used.
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useSettingsStore();

    await store.updateEditorSettingsAndPersist({ dataGridTypeColorSchemes: [SCHEME], activeDataGridTypeColorSchemeId: SCHEME.id });

    const last = saved.at(-1) as Record<string, unknown> | undefined;
    expect(last?.dataGridTypeColorSchemes).toEqual([SCHEME]);
    expect(last?.activeDataGridTypeColorSchemeId).toBe(SCHEME.id);
  });

  it("stages scheme edits in the settings draft", () => {
    const dialogSource = readFileSync(new URL("../../components/editor/EditorSettingsDialog.vue", import.meta.url), "utf8");

    expect(dialogSource).toContain("editDataGridTypeColorSchemes.value = cloneDataGridTypeColorSchemes(schemes)");
    expect(dialogSource).not.toContain("structuredClone(settingsStore.editorSettings.dataGridTypeColorSchemes)");
    expect(dialogSource).toContain("editActiveDataGridTypeColorSchemeId.value = activeId");
    expect(dialogSource).not.toMatch(/settingsStore\.updateEditorSettings\w*\(\{[^}]*DataGridTypeColorScheme/);
  });

  it("restores a persisted scheme through normalization", async () => {
    const { normalizeEditorSettings } = await import("@/stores/settingsStore");

    const restored = normalizeEditorSettings({ dataGridTypeColorSchemes: [SCHEME], activeDataGridTypeColorSchemeId: SCHEME.id });

    expect(restored.dataGridTypeColorSchemes).toEqual([SCHEME]);
    expect(restored.activeDataGridTypeColorSchemeId).toBe(SCHEME.id);
  });
});
