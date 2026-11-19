// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_PLUGIN_SETTINGS } from "@/lib/plugins/pluginCenterNavigation";
import PluginShortcutToolbar from "./PluginShortcutToolbar.vue";
import { normalizePluginShortcutSettings } from "@/lib/plugins/pluginShortcuts";

const mocks = vi.hoisted(() => ({ openSettings: vi.fn(), open: vi.fn(), save: vi.fn(), toast: vi.fn(), state: null as any, entries: null as any }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => mocks.state }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/composables/usePluginShortcuts", () => ({ usePluginShortcuts: () => ({ entries: mocks.entries, open: mocks.open, isActive: (entry: any) => entry.id === "a" }) }));
vi.mock("./PluginIcon.vue", () => ({ default: { props: ["pluginId"], template: '<span data-plugin-icon :data-plugin-id="pluginId" />' } }));
vi.mock("@/components/ui/LightTooltip.vue", () => ({ default: { template: "<slot />" } }));

let app: ReturnType<typeof createApp>;
let host: HTMLDivElement;
const dropdownOnly = ref(false);
let width: number | undefined;
let resize: () => void;
const flush = async () => {
  for (let i = 0; i < 6; i++) {
    await nextTick();
    await Promise.resolve();
  }
};
beforeEach(() => {
  vi.clearAllMocks();
  width = undefined;
  dropdownOnly.value = false;
  mocks.state = reactive({ isEditorSettingsLoaded: true, editorSettings: { pluginShortcuts: normalizePluginShortcutSettings({ position: "toolbar", toolbarCount: 2, showSettingsEntry: false }) }, updateEditorSettingsAndPersist: mocks.save });
  mocks.entries = ref(["a", "b", "c", "d", "e"].map((id) => ({ id, pluginId: id, label: `Function ${id}`, pluginName: `Plugin ${id}`, kind: "workbench", targetId: id, disabled: false })));
  mocks.save.mockResolvedValue(undefined);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-plugin-shortcut-toolbar") ? (width ?? parseFloat(this.style.width)) : 28;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(PluginShortcutToolbar, { dropdownOnly: dropdownOnly.value }) });
  app.provide(OPEN_PLUGIN_SETTINGS, mocks.openSettings);
  app.mount(host);
});
afterEach(() => {
  app.unmount();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function openMenu() {
  await flush();
  const trigger = host.querySelector<HTMLElement>('button[aria-haspopup="menu"]')!;
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.querySelector("[data-plugin-shortcut-overflow]")).not.toBeNull());
  await flush();
}
function rect(x: number, y: number, w: number, h: number): DOMRect {
  return { x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h, toJSON() {} };
}
function pointer(target: EventTarget, type: string, x: number, y: number) {
  target.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
}

describe("floating plugin shortcuts", () => {
  it.each([false, true])("keeps drag previews in the viewport (dropdownOnly=%s)", async (menuOnly) => {
    dropdownOnly.value = menuOnly;
    if (menuOnly) await openMenu();
    else await flush();
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-shortcut-drag-preview") ? rect(0, 0, 180, 32) : original.call(this);
    });
    const item = document.querySelector<HTMLElement>("[data-shortcut-id]")!;
    pointer(item, "pointerdown", 16, 16);
    pointer(window, "pointermove", window.innerWidth - 2, window.innerHeight - 2);
    await flush();
    const preview = document.querySelector<HTMLElement>("[data-shortcut-drag-preview]")!;
    expect(preview.style.left).toBe(`${window.innerWidth - 194}px`);
    expect(preview.style.top).toBe(`${window.innerHeight - 46}px`);
    pointer(window, "pointermove", 2, 2);
    await flush();
    expect(preview.style.left).toBe("14px");
    expect(preview.style.top).toBe("14px");
  });

  it.each([false, true])("keeps settings as the last non-sortable menu action (dropdownOnly=%s)", async (menuOnly) => {
    dropdownOnly.value = menuOnly;
    mocks.state.editorSettings.pluginShortcuts.showSettingsEntry = true;
    await openMenu();
    const menu = document.querySelector<HTMLElement>("[data-plugin-shortcut-overflow]")!;
    const action = menu.querySelector<HTMLElement>("[data-plugin-shortcut-settings]")!;
    expect(menu.lastElementChild).toBe(action);
    expect(action.hasAttribute("data-shortcut-id")).toBe(false);
    pointer(action, "pointerdown", 16, 80);
    pointer(window, "pointermove", 1, 1);
    pointer(window, "pointerup", 1, 1);
    await flush();
    expect(mocks.save).not.toHaveBeenCalled();
    action.click();
    expect(mocks.openSettings).toHaveBeenCalledOnce();
    await flush();
    expect(document.querySelector("[data-plugin-shortcut-overflow]")).toBeNull();
  });
  it("reserves room for inline settings and moves it to overflow when the toolbar shrinks", async () => {
    mocks.state.editorSettings.pluginShortcuts.showSettingsEntry = true;
    mocks.state.editorSettings.pluginShortcuts.toolbarCount = 10;
    await flush();
    const buttons = host.querySelectorAll("button");
    expect(buttons[buttons.length - 1]?.hasAttribute("data-plugin-shortcut-settings")).toBe(true);
    width = 34;
    resize();
    await flush();
    expect(host.querySelector("[data-plugin-shortcut-settings]")).toBeNull();
    await openMenu();
    expect(document.querySelector("[data-plugin-shortcut-overflow]")?.lastElementChild?.hasAttribute("data-plugin-shortcut-settings")).toBe(true);
    mocks.state.editorSettings.pluginShortcuts.showSettingsEntry = false;
    await flush();
    expect(document.querySelector("[data-plugin-shortcut-settings]")).toBeNull();
  });
  it.each([false, true])("hides the entire area without visible plugins even when settings is enabled (dropdownOnly=%s)", async (menuOnly) => {
    dropdownOnly.value = menuOnly;
    mocks.state.editorSettings.pluginShortcuts.showSettingsEntry = true;
    await openMenu();
    const originalEntries = mocks.entries.value;
    mocks.entries.value = [];
    await flush();
    expect(host.querySelector("nav")).toBeNull();
    expect(document.querySelector("[data-plugin-shortcut-settings]")).toBeNull();
    expect(document.querySelector("[data-plugin-shortcut-overflow]")).toBeNull();
    mocks.entries.value = originalEntries;
    await flush();
    expect(host.querySelector("nav")).not.toBeNull();
    expect(document.querySelector("[data-plugin-shortcut-overflow]")).toBeNull();
  });
  it("shows all shortcuts beside Plugin Center regardless of the floating icon count", async () => {
    dropdownOnly.value = true;
    mocks.state.editorSettings.pluginShortcuts.toolbarCount = 10;
    await flush();
    expect(host.querySelectorAll("[data-shortcut-id]")).toHaveLength(0);
    await openMenu();
    const rows = document.querySelectorAll<HTMLElement>('[data-plugin-shortcut-overflow] [role="menuitem"]');
    expect([...rows].map((row) => row.textContent?.trim())).toEqual(["Function a", "Function b", "Function c", "Function d", "Function e"]);
    rows[1].click();
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
    await flush();
    expect(document.querySelector("[data-plugin-shortcut-overflow]")).toBeNull();
  });
  it("sorts within the Plugin Center dropdown and retains unavailable entry positions", async () => {
    dropdownOnly.value = true;
    mocks.state.editorSettings.pluginShortcuts.position = "plugin-center";
    mocks.state.editorSettings.pluginShortcuts.order = ["a", "hidden", "b", "c", "d", "e"];
    await openMenu();
    const root = host.querySelector<HTMLElement>("[data-plugin-shortcut-toolbar]")!;
    const menu = document.querySelector<HTMLElement>("[data-plugin-shortcut-overflow]")!;
    root.getBoundingClientRect = () => rect(0, 0, 28, 32);
    menu.getBoundingClientRect = () => rect(0, 40, 240, 160);
    const rows = menu.querySelectorAll<HTMLElement>("[data-shortcut-id]");
    rows.forEach((row, i) => {
      row.getBoundingClientRect = () => rect(0, 40 + i * 32, 240, 32);
    });
    pointer(rows[2], "pointerdown", 20, 120);
    pointer(window, "pointermove", 20, 41);
    pointer(window, "pointerup", 20, 41);
    await flush();
    expect(mocks.save).toHaveBeenCalledWith({ pluginShortcuts: expect.objectContaining({ position: "plugin-center", order: ["c", "hidden", "a", "b", "d", "e"] }) });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("shows the requested icons and renders remaining entries as named menu rows", async () => {
    await flush();
    expect(host.querySelectorAll("[data-shortcut-id]")).toHaveLength(2);
    await openMenu();
    const items = document.querySelectorAll<HTMLElement>('[data-plugin-shortcut-overflow] [role="menuitem"]');
    expect([...items].map((item) => item.textContent?.trim())).toEqual(["Function c", "Function d", "Function e"]);
    expect(items[0].querySelector("[data-plugin-icon]")).not.toBeNull();
    items[0].click();
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ id: "c" }));
  });
  it("supports all-in-menu and hides the arrow when everything fits", async () => {
    mocks.state.editorSettings.pluginShortcuts.toolbarCount = 0;
    await flush();
    expect(host.querySelectorAll("[data-shortcut-id]")).toHaveLength(0);
    expect(host.querySelector('button[aria-haspopup="menu"]')).not.toBeNull();
    mocks.state.editorSettings.pluginShortcuts.toolbarCount = 10;
    await flush();
    expect(host.querySelectorAll("[data-shortcut-id]")).toHaveLength(5);
    expect(host.querySelector('button[aria-haspopup="menu"]')).toBeNull();
  });
  it("automatically collapses into a menu when width is limited", async () => {
    await flush();
    width = 34;
    resize();
    await flush();
    expect(host.querySelectorAll("[data-shortcut-id]")).toHaveLength(0);
    expect(host.querySelector('button[aria-haspopup="menu"]')).not.toBeNull();
  });
  it("sorts from the portalled menu into the inline strip without launching", async () => {
    await openMenu();
    const root = host.querySelector<HTMLElement>("[data-plugin-shortcut-toolbar]")!;
    const menu = document.querySelector<HTMLElement>("[data-plugin-shortcut-overflow]")!;
    root.getBoundingClientRect = () => rect(0, 0, 94, 32);
    menu.getBoundingClientRect = () => rect(0, 40, 240, 100);
    root.querySelectorAll<HTMLElement>("[data-shortcut-id]").forEach((item, i) => {
      item.getBoundingClientRect = () => rect(i * 30, 0, 28, 28);
    });
    const rows = menu.querySelectorAll<HTMLElement>("[data-shortcut-id]");
    rows.forEach((item, i) => {
      item.getBoundingClientRect = () => rect(0, 40 + i * 32, 240, 32);
    });
    pointer(rows[0], "pointerdown", 20, 56);
    pointer(window, "pointermove", 1, 1);
    pointer(window, "pointerup", 1, 1);
    await flush();
    expect(mocks.save).toHaveBeenCalledWith({ pluginShortcuts: expect.objectContaining({ order: ["c", "a", "b", "d", "e"] }) });
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("does not leave an empty floating shell after all plugins are hidden", async () => {
    mocks.entries.value = [];
    await flush();
    expect(host.querySelector("nav")).toBeNull();
  });
});
