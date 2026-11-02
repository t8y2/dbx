import { reactive } from "vue";
import { describe, expect, it, vi } from "vitest";
import { usePluginShortcutPreferences } from "../usePluginShortcutPreferences";
import { normalizePluginShortcutSettings } from "@/lib/plugins/pluginShortcuts";

const mocks = vi.hoisted(() => ({ settings: null as any }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => mocks.settings }));

describe("shortcut preference writes", () => {
  it("merges queued writes from different controls without replacing unrelated preferences", async () => {
    const state = reactive({ pluginShortcuts: normalizePluginShortcutSettings({}) });
    mocks.settings = {
      editorSettings: state,
      updateEditorSettingsAndPersist: vi.fn(async (patch) => {
        state.pluginShortcuts = patch.pluginShortcuts;
      }),
    };
    const bar = usePluginShortcutPreferences();
    const page = usePluginShortcutPreferences();
    await Promise.all([bar.update({ order: ["a", "b"] }), page.update({ hiddenPluginIds: ["p"] }), bar.update({ sidebarHeight: 132 })]);
    expect(state.pluginShortcuts).toMatchObject({ order: ["a", "b"], hiddenPluginIds: ["p"], sidebarHeight: 132 });
  });
  it("continues after a failed write without carrying its unpersisted patch forward", async () => {
    const state = reactive({ pluginShortcuts: normalizePluginShortcutSettings({}) });
    mocks.settings = {
      editorSettings: state,
      updateEditorSettingsAndPersist: vi
        .fn()
        .mockRejectedValueOnce(new Error("disk full"))
        .mockImplementation(async (patch) => {
          state.pluginShortcuts = patch.pluginShortcuts;
        }),
    };
    const preferences = usePluginShortcutPreferences();
    const failed = preferences.update({ order: ["lost"] });
    const next = preferences.update({ hiddenPluginIds: ["p"] });
    await expect(failed).rejects.toThrow("disk full");
    await next;
    expect(state.pluginShortcuts).toMatchObject({ order: [], hiddenPluginIds: ["p"] });
  });
});
