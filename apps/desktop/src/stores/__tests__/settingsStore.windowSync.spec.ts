import { createPinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), emit: vi.fn(async () => {}) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/backend/api", () => ({ loadEditorSettings: mocks.load, saveEditorSettings: mocks.save }));
vi.mock("@tauri-apps/api/event", () => ({ emit: mocks.emit }));
import { DEFAULT_EDITOR_SETTINGS, useSettingsStore } from "@/stores/settingsStore";

beforeEach(() => {
  mocks.load.mockResolvedValue(JSON.parse(JSON.stringify(DEFAULT_EDITOR_SETTINGS)));
  mocks.save.mockReset();
  mocks.emit.mockClear();
  mocks.save.mockResolvedValue({});
});

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
});
