// @vitest-environment happy-dom
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EDITOR_SETTINGS, STORAGE_KEY, useSettingsStore } from "../settingsStore";

const backend = vi.hoisted(() => ({ loadEditorSettings: vi.fn(), saveEditorSettings: vi.fn() }));
vi.mock("@/lib/backend/api", () => backend);

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  setActivePinia(createPinia());
  backend.saveEditorSettings.mockResolvedValue(undefined);
});

describe("sidebar menu preference migration and persistence", () => {
  it("defaults both new and existing installations without a menu choice to grouped menus", async () => {
    backend.loadEditorSettings.mockResolvedValue(null);
    const fresh = useSettingsStore();
    await fresh.initEditorSettings();
    expect(fresh.editorSettings.sidebarMenuLayout).toBe("grouped");
    setActivePinia(createPinia());
    const { sidebarMenuLayout: _layout, ...legacy } = DEFAULT_EDITOR_SETTINGS;
    backend.loadEditorSettings.mockResolvedValue(legacy);
    const existing = useSettingsStore();
    await existing.initEditorSettings();
    expect(existing.editorSettings.sidebarMenuLayout).toBe("grouped");
  });

  it.each([
    [STORAGE_KEY, JSON.stringify({ fontSize: 18 })],
    ["dbx-query-editor-font-size", "18"],
  ])("defaults legacy local preferences from %s to grouped menus", async (key, value) => {
    backend.loadEditorSettings.mockResolvedValue(null);
    localStorage.setItem(key, value);
    const store = useSettingsStore();
    await store.initEditorSettings();
    expect(store.editorSettings.fontSize).toBe(18);
    expect(store.editorSettings.sidebarMenuLayout).toBe("grouped");
    expect(backend.saveEditorSettings.mock.calls.at(-1)![0].sidebarMenuLayout).toBe("grouped");
  });

  it("persists the chosen layout and separate action IDs, and restores them after reload", async () => {
    backend.loadEditorSettings.mockResolvedValue(DEFAULT_EDITOR_SETTINGS);
    const store = useSettingsStore();
    await store.initEditorSettings();
    await store.updateEditorSettingsAndPersist({
      sidebarMenuLayout: "full",
      sidebarMenuPinnedActions: { table: ["contextMenu.exportData"], database: ["diff.title"], "sql-editor": ["editor.contextMenu.export"] },
      sidebarMenuHiddenPrimaryActions: { connection: ["contextMenu.serverDashboard", "contextMenu.configureVisibleObjects"], table: ["sidebar.togglePinnedObject"] },
      sidebarMenuOrder: { table: ["contextMenu.exportData", "group.copy", "group.structure"] },
    });
    const snapshot = backend.saveEditorSettings.mock.calls.at(-1)![0];
    expect(snapshot.sidebarMenuPinnedActions).toEqual({ table: ["contextMenu.exportData"], database: ["diff.title"], "sql-editor": ["editor.contextMenu.export"] });
    setActivePinia(createPinia());
    backend.loadEditorSettings.mockResolvedValue(snapshot);
    const restored = useSettingsStore();
    await restored.initEditorSettings();
    expect(restored.editorSettings.sidebarMenuLayout).toBe("full");
    expect(restored.editorSettings.sidebarMenuPinnedActions.table).toEqual(["contextMenu.exportData"]);
    expect(restored.editorSettings.sidebarMenuPinnedActions["sql-editor"]).toEqual(["editor.contextMenu.export"]);
    expect(restored.editorSettings.sidebarMenuHiddenPrimaryActions.connection).toEqual(["contextMenu.serverDashboard", "contextMenu.configureVisibleObjects"]);
    expect(restored.editorSettings.sidebarMenuHiddenPrimaryActions.table).toEqual(["sidebar.togglePinnedObject"]);
    expect(restored.editorSettings.sidebarMenuOrder.table).toEqual(["contextMenu.exportData", "group.copy", "group.structure"]);
  });

  it("rolls back both preferences when saving fails", async () => {
    backend.loadEditorSettings.mockResolvedValue(DEFAULT_EDITOR_SETTINGS);
    const store = useSettingsStore();
    await store.initEditorSettings();
    backend.saveEditorSettings.mockRejectedValue(new Error("read-only storage"));
    await expect(store.updateEditorSettingsAndPersist({ sidebarMenuLayout: "full", sidebarMenuPinnedActions: { table: ["contextMenu.exportData"] }, sidebarMenuHiddenPrimaryActions: { connection: ["contextMenu.serverDashboard"] }, sidebarMenuOrder: { table: ["group.copy"] } })).rejects.toThrow(
      "read-only storage",
    );
    expect(store.editorSettings.sidebarMenuLayout).toBe("grouped");
    expect(store.editorSettings.sidebarMenuPinnedActions).toEqual({});
    expect(store.editorSettings.sidebarMenuHiddenPrimaryActions).toEqual({});
    expect(store.editorSettings.sidebarMenuOrder).toEqual({});
  });
});
