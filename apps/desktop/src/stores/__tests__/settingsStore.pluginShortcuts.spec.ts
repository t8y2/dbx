import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ loadEditorSettings: mocks.load, saveEditorSettings: mocks.save }));
import { useSettingsStore } from "../settingsStore";

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.load.mockResolvedValue({});
  mocks.save.mockResolvedValue(undefined);
});
describe("plugin shortcut persistence", () => {
  it.each(["sidebar-bottom", "plugin-center"] as const)("restores %s preferences after restart and rolls back failed writes", async (position) => {
    let saved: unknown = {};
    mocks.load.mockImplementation(async () => saved);
    mocks.save.mockImplementation(async (value) => {
      saved = JSON.parse(JSON.stringify(value));
    });
    const first = useSettingsStore();
    await first.initEditorSettings();
    const pluginShortcuts = { enabled: false, position, order: ["b", "missing", "a"], hiddenPluginIds: ["hidden"], sidebarHeight: 132, toolbarCount: 6 };
    await first.updateEditorSettingsAndPersist({ pluginShortcuts });
    setActivePinia(createPinia());
    const second = useSettingsStore();
    await second.initEditorSettings();
    expect(second.editorSettings.pluginShortcuts).toEqual(pluginShortcuts);
    mocks.save.mockRejectedValueOnce(new Error("disk full"));
    await expect(second.updateEditorSettingsAndPersist({ pluginShortcuts: { ...pluginShortcuts, enabled: true } })).rejects.toThrow("disk full");
    expect(second.editorSettings.pluginShortcuts).toEqual(pluginShortcuts);
  });
});
