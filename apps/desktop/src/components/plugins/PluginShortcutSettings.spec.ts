// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePluginShortcutSettings } from "@/lib/plugins/pluginShortcuts";
import PluginShortcutSettings from "./PluginShortcutSettings.vue";
const mocks = vi.hoisted(() => ({ state: null as any, save: vi.fn(), toast: vi.fn() }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => mocks.state }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/composables/usePluginShortcuts", () => ({
  usePluginShortcuts: () => ({
    allEntries: {
      value: [
        { pluginId: "p", pluginName: "Plugin", id: "one" },
        { pluginId: "p", pluginName: "Plugin", id: "two" },
      ],
    },
  }),
}));
vi.mock("./PluginIcon.vue", () => ({ default: { template: "<span />" } }));
let app: ReturnType<typeof createApp>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = reactive({ isEditorSettingsLoaded: true, editorSettings: { pluginShortcuts: normalizePluginShortcutSettings({ order: ["saved"] }) }, updateEditorSettingsAndPersist: mocks.save });
  mocks.save.mockImplementation(async ({ pluginShortcuts }) => {
    mocks.state.editorSettings.pluginShortcuts = pluginShortcuts;
  });
  container = document.createElement("div");
  document.body.append(container);
  app = createApp({ render: () => h(PluginShortcutSettings) });
  app.mount(container);
});
afterEach(() => {
  app.unmount();
  container.remove();
});
describe("plugin shortcut settings", () => {
  it("selects the Plugin Center dropdown and preserves unrelated preferences", async () => {
    const trigger = container.querySelector<HTMLElement>('[role="combobox"]')!;
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes("shortcutsPluginCenter"))!;
    option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(mocks.state.editorSettings.pluginShortcuts.position).toBe("plugin-center"));
    expect(mocks.state.editorSettings.pluginShortcuts.order).toEqual(["saved"]);
    expect(container.querySelector("#plugin-shortcuts-toolbar-count")).toBeNull();
  });
  it("shows one toggle per plugin and preserves choices under the global switch", async () => {
    const switches = container.querySelectorAll<HTMLElement>('[role="switch"]');
    expect(switches).toHaveLength(2);
    switches[1].click();
    await vi.waitFor(() => expect(mocks.state.editorSettings.pluginShortcuts.hiddenPluginIds).toEqual(["p"]));
    await vi.waitFor(() => expect(switches[0].hasAttribute("disabled")).toBe(false));
    switches[0].click();
    await vi.waitFor(() => expect(mocks.state.editorSettings.pluginShortcuts.enabled).toBe(false));
    expect(mocks.state.editorSettings.pluginShortcuts.hiddenPluginIds).toEqual(["p"]);
    expect(mocks.state.editorSettings.pluginShortcuts.order).toEqual(["saved"]);
  });
  it("hides the position choice when switched off and preserves position and order", async () => {
    (container.querySelector('[role="switch"]') as HTMLElement).click();
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    await nextTick();
    expect(mocks.state.editorSettings.pluginShortcuts).toEqual(normalizePluginShortcutSettings({ enabled: false, order: ["saved"] }));
    expect(container.querySelector('[role="combobox"]')).toBeNull();
  });
  it("keeps the current value and shows errors when persistence fails", async () => {
    mocks.save.mockRejectedValueOnce(new Error("disk full"));
    (container.querySelector('[role="switch"]') as HTMLElement).click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(mocks.state.editorSettings.pluginShortcuts.enabled).toBe(true);
    expect(container.querySelector('[role="combobox"]')).not.toBeNull();
  });
});
