import { createPinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), desktopSave: vi.fn(), emit: vi.fn(async (_event: string, _snapshot: unknown) => {}) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/backend/api", () => ({ loadEditorSettings: mocks.load, saveEditorSettings: mocks.save, saveDesktopSettings: mocks.desktopSave }));
vi.mock("@tauri-apps/api/event", () => ({ emit: mocks.emit }));
import { DEFAULT_EDITOR_SETTINGS, useSettingsStore } from "@/stores/settingsStore";

beforeEach(() => {
  mocks.load.mockResolvedValue(JSON.parse(JSON.stringify(DEFAULT_EDITOR_SETTINGS)));
  mocks.save.mockReset();
  mocks.emit.mockReset().mockResolvedValue(undefined);
  mocks.save.mockResolvedValue({});
  mocks.desktopSave.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("settings shared between workspaces", () => {
  it("broadcasts tab grouping and placement changes when the native save returns null", async () => {
    const first = useSettingsStore(createPinia());
    const second = useSettingsStore(createPinia());
    await Promise.all([first.initEditorSettings(), second.initEditorSettings()]);
    mocks.save.mockResolvedValue(null);
    await first.updateEditorSettingsAndPersist({ tabPlacement: "right", tabGroupRows: "two-row", tabGroupMode: "connection" });
    expect(mocks.emit).toHaveBeenCalledWith("dbx:editor-settings-changed", expect.objectContaining({ tabPlacement: "right", tabGroupRows: "two-row" }));
    const snapshot = mocks.emit.mock.calls.find(([event]) => event === "dbx:editor-settings-changed")![1];
    second.applySharedEditorSettings(snapshot);
    expect(second.editorSettings.tabPlacement).toBe("right");
    expect(second.editorSettings.tabGroupRows).toBe("two-row");
    expect(second.editorSettings.tabGroupMode).toBe("connection");
  });

  it("saves only locally changed fields and applies remote fonts and zoom without saving again", async () => {
    const first = useSettingsStore(createPinia());
    const second = useSettingsStore(createPinia());
    await Promise.all([first.initEditorSettings(), second.initEditorSettings()]);
    await first.updateEditorSettingsAndPersist({ uiScale: 1.25, uiFontFamily: "Arial" });
    expect(mocks.save.mock.calls.at(-1)?.[1]).toEqual({ uiScale: 1.25, uiFontFamily: "Arial" });
    const calls = mocks.save.mock.calls.length;
    second.applySharedEditorSettings(first.editorSettings);
    expect(second.editorSettings.uiScale).toBe(1.25);
    expect(second.editorSettings.uiFontFamily).toBe("Arial");
    expect(mocks.save).toHaveBeenCalledTimes(calls);
    await second.updateEditorSettingsAndPersist({ fontSize: 18 });
    expect(mocks.save.mock.calls.at(-1)?.[1]).toEqual({ fontSize: 18 });
    expect(second.editorSettings.uiScale).toBe(1.25);
  });

  it("preserves uncommitted local fields when another window's snapshot arrives", async () => {
    const store = useSettingsStore(createPinia());
    await store.initEditorSettings();
    let release!: (value: unknown) => void;
    mocks.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const save = store.updateEditorSettingsAndPersist({ fontSize: 22 });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    store.applySharedEditorSettings({ ...DEFAULT_EDITOR_SETTINGS, fontSize: 14, uiScale: 1.5 });
    expect(store.editorSettings.fontSize).toBe(22);
    expect(store.editorSettings.uiScale).toBe(1.5);
    release({});
    await save;
  });

  it("keeps a committed editor setting when the fallback notification fails", async () => {
    const store = useSettingsStore(createPinia());
    await store.initEditorSettings();
    const error = new Error("event unavailable");
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.save.mockResolvedValueOnce(null);
    mocks.emit.mockRejectedValueOnce(error);
    await expect(store.updateEditorSettingsAndPersist({ fontSize: 24 })).resolves.toBeUndefined();
    expect(store.editorSettings.fontSize).toBe(24);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 24 }), { fontSize: 24 });
    expect(log).toHaveBeenCalledWith("[DBX][settings:notify]", error);
  });

  it("keeps committed desktop settings when notification delivery fails", async () => {
    const store = useSettingsStore(createPinia());
    const error = new Error("event unavailable");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.emit.mockRejectedValueOnce(error);
    await expect(store.updateDesktopSettings({ quit_on_close: true })).resolves.toBeUndefined();
    expect(store.desktopSettings.quit_on_close).toBe(true);
    expect(mocks.desktopSave).toHaveBeenCalledWith(expect.objectContaining({ quit_on_close: true }));
  });

  it("rolls back failed writes without publishing a settings notification", async () => {
    const store = useSettingsStore(createPinia());
    await store.initEditorSettings();
    const originalFontSize = store.editorSettings.fontSize;
    mocks.save.mockRejectedValueOnce(new Error("disk full"));
    await expect(store.updateEditorSettingsAndPersist({ fontSize: 24 })).rejects.toThrow("disk full");
    expect(store.editorSettings.fontSize).toBe(originalFontSize);
    const originalQuitSetting = store.desktopSettings.quit_on_close;
    mocks.desktopSave.mockRejectedValueOnce(new Error("disk full"));
    await expect(store.updateDesktopSettings({ quit_on_close: !originalQuitSetting })).rejects.toThrow("disk full");
    expect(store.desktopSettings.quit_on_close).toBe(originalQuitSetting);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
