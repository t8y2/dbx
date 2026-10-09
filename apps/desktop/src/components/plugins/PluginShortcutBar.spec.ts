// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_PLUGIN_SETTINGS } from "@/lib/plugins/pluginCenterNavigation";
import PluginShortcutBar from "./PluginShortcutBar.vue";
import { normalizePluginShortcutSettings, type PluginShortcutPosition } from "@/lib/plugins/pluginShortcuts";

const mocks = vi.hoisted(() => ({ openSettings: vi.fn(), open: vi.fn(), save: vi.fn(), toast: vi.fn(), state: null as any, entries: null as any, allEntries: null as any }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => mocks.state }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/composables/usePluginShortcuts", () => ({ usePluginShortcuts: () => ({ entries: mocks.entries, allEntries: mocks.allEntries, open: mocks.open, isActive: (entry: any) => entry.id === "b" }) }));
vi.mock("./PluginIcon.vue", () => ({ default: { template: "<span />" } }));
vi.mock("@/components/ui/LightTooltip.vue", () => ({ default: { props: ["text", "disabled"], template: "<span :data-tooltip='text'><slot /></span>" } }));

let app: ReturnType<typeof createApp>;
let container: HTMLDivElement;
const flush = async () => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await nextTick();
  }
};
function box(x: number, y: number, width: number, height: number) {
  return { x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON() {} };
}
function mount(position: PluginShortcutPosition) {
  container = document.createElement("div");
  document.body.append(container);
  app = createApp({ render: () => h(PluginShortcutBar, { position }) });
  app.provide(OPEN_PLUGIN_SETTINGS, mocks.openSettings);
  app.mount(container);
  const scroll = container.querySelector("[data-shortcut-scroll]") as HTMLElement;
  scroll.getBoundingClientRect = () => box(0, 0, 100, 200);
  const items = container.querySelectorAll<HTMLElement>("[data-shortcut-id]");
  items.forEach((item, i) => {
    item.getBoundingClientRect = () => box(0, i * 36, position === "sidebar-bottom" ? 100 : 32, 32);
  });
  return items;
}
function pointer(element: EventTarget, type: string, x: number, y: number) {
  element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: x, clientY: y }));
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = reactive({ isEditorSettingsLoaded: true, editorSettings: { pluginShortcuts: normalizePluginShortcutSettings({ showSettingsEntry: false }) }, updateEditorSettingsAndPersist: mocks.save });
  mocks.entries = ref(["a", "b", "c"].map((id) => ({ id, pluginId: id, label: `Function ${id}`, pluginName: `Plugin ${id}`, kind: "workbench", targetId: id, disabled: false })));
  mocks.allEntries = ref([...mocks.entries.value]);
  mocks.save.mockResolvedValue(undefined);
});
afterEach(() => {
  app?.unmount();
  container?.remove();
  vi.restoreAllMocks();
});

describe("plugin shortcut bar", () => {
  it("keeps the visibility menu open for repeated toggles and reflects failed saves", async () => {
    mocks.save.mockImplementation(async (patch: any) => {
      mocks.state.editorSettings.pluginShortcuts = patch.pluginShortcuts;
    });
    mount("right-top");
    container.querySelector("nav")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await flush();
    const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")];
    buttons()[0].click();
    await flush();
    expect(buttons()[0].getAttribute("aria-pressed")).toBe("false");
    buttons()[1].click();
    await flush();
    expect(mocks.state.editorSettings.pluginShortcuts.hiddenPluginIds).toEqual(["a", "b"]);
    buttons()[0].click();
    await flush();
    expect(buttons()[0].getAttribute("aria-pressed")).toBe("true");
    expect(mocks.state.editorSettings.pluginShortcuts.hiddenPluginIds).toEqual(["b"]);
    mocks.save.mockRejectedValueOnce(new Error("disk full"));
    buttons()[1].click();
    await flush();
    expect(buttons()[1].getAttribute("aria-pressed")).toBe("false");
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("disk full"), 5000);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(buttons()).toHaveLength(0);
  });

  it("lists hidden plugins on blank-area right-click and restores them", async () => {
    mocks.state.editorSettings.pluginShortcuts.hiddenPluginIds = ["b"];
    mocks.entries.value = mocks.entries.value.filter((entry: any) => entry.pluginId !== "b");
    mount("right-top");
    container.querySelector("nav")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await flush();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(["Plugin a", "Plugin b", "Plugin c"]);
    buttons[1].click();
    await flush();
    expect(mocks.save).toHaveBeenCalledWith({ pluginShortcuts: { ...mocks.state.editorSettings.pluginShortcuts, hiddenPluginIds: [] } });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("retains the context-menu surface when every plugin is hidden", async () => {
    mount("right-top");
    mocks.entries.value = [];
    mocks.state.editorSettings.pluginShortcuts.hiddenPluginIds = ["a", "b", "c"];
    await flush();
    const bar = container.querySelector("nav")!;
    expect(bar).not.toBeNull();
    bar.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await flush();
    expect(document.querySelectorAll("[data-dbx-context-menu] button")).toHaveLength(3);
  });

  it.each(["left-top", "right-top", "sidebar-bottom"] as const)("keeps the measured preview inside both edges at %s", async (position) => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-shortcut-drag-preview") ? box(0, 0, 180, 32) : original.call(this);
    });
    const items = mount(position);
    pointer(items[0], "pointerdown", 16, 16);
    pointer(window, "pointermove", window.innerWidth - 2, window.innerHeight - 2);
    await flush();
    const preview = document.querySelector<HTMLElement>("[data-shortcut-drag-preview]")!;
    expect(preview.style.left).toBe(`${window.innerWidth - 194}px`);
    expect(preview.style.top).toBe(`${window.innerHeight - 46}px`);
    pointer(window, "pointermove", 2, 2);
    await flush();
    expect(preview.style.left).toBe("14px");
    expect(preview.style.top).toBe("14px");
    expect(preview.style.visibility).not.toBe("hidden");
  });

  it.each(["left-top", "left-bottom", "right-top", "right-bottom", "sidebar-bottom"] as const)("keeps settings last and outside sorting at %s", async (position) => {
    mocks.state.editorSettings.pluginShortcuts.showSettingsEntry = true;
    mount(position);
    const button = container.querySelector<HTMLElement>("[data-plugin-shortcut-settings]")!;
    const buttons = container.querySelectorAll("button");
    if (position === "sidebar-bottom") {
      expect(container.querySelector("[data-shortcut-header]")?.contains(button)).toBe(true);
      expect(container.querySelector("[data-shortcut-scroll] [data-plugin-shortcut-settings]")).toBeNull();
    } else expect(buttons[buttons.length - 1]).toBe(button);
    expect(button.closest("[data-shortcut-id]")).toBeNull();
    pointer(button, "pointerdown", 16, 120);
    pointer(window, "pointermove", 1, 1);
    pointer(window, "pointerup", 1, 1);
    await flush();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(document.querySelector(".shortcut-drag-preview")).toBeNull();
    button.click();
    expect(mocks.openSettings).toHaveBeenCalledOnce();
    mocks.entries.value = [];
    mocks.allEntries.value = [];
    await flush();
    expect(container.querySelector("[data-plugin-shortcut-settings]")).toBeNull();
    expect(container.querySelector("nav")).toBeNull();
    mocks.state.editorSettings.pluginShortcuts.showSettingsEntry = false;
    await flush();
    expect(container.querySelector("nav")).toBeNull();
  });
  it.each(["left-top", "left-bottom", "right-top", "right-bottom", "sidebar-bottom"] as const)("sorts with pointer events at %s without launching on release", async (position) => {
    const items = mount(position);
    await nextTick();
    const from = items[2].getBoundingClientRect();
    pointer(items[2], "pointerdown", from.x + 16, from.y + 16);
    pointer(window, "pointermove", 1, 1);
    await nextTick();
    expect(items[0].classList.contains("drop-before")).toBe(true);
    expect(document.querySelector(".shortcut-drag-preview")).not.toBeNull();
    pointer(window, "pointerup", 1, 1);
    await flush();
    expect(mocks.save).toHaveBeenCalledWith({ pluginShortcuts: { ...normalizePluginShortcutSettings({ showSettingsEntry: false }), order: ["c", "a", "b"] } });
    (items[2].querySelector("button") as HTMLElement).click();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(document.querySelector(".shortcut-drag-preview")).toBeNull();
  });
  it("preserves ordinary clicks below the drag threshold", async () => {
    const items = mount("right-top");
    pointer(items[0], "pointerdown", 16, 16);
    pointer(window, "pointermove", 19, 18);
    pointer(window, "pointerup", 19, 18);
    (items[0].querySelector("button") as HTMLElement).click();
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each(["escape", "blur", "pointercancel", "outside"])("cancels via %s", async (reason) => {
    const items = mount("right-top");
    await nextTick();
    pointer(items[2], "pointerdown", 16, 88);
    pointer(window, "pointermove", 1, 1);
    if (reason === "escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    else if (reason === "outside") pointer(window, "pointerup", 150, 1);
    else window.dispatchEvent(new Event(reason));
    pointer(window, "pointerup", 1, 1);
    await flush();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(document.querySelector(".shortcut-pointer-overlay")).toBeNull();
  });
  it("reports save failures and shows only the function name in the tooltip", async () => {
    const items = mount("right-top");
    await nextTick();
    expect(container.querySelector("[data-tooltip]")?.getAttribute("data-tooltip")).toBe("Function a");
    mocks.save.mockRejectedValueOnce(new Error("disk full"));
    pointer(items[2], "pointerdown", 16, 88);
    pointer(window, "pointermove", 1, 1);
    pointer(window, "pointerup", 1, 1);
    await flush();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("disk full"), 5000);
  });
  it("auto-scrolls near the edge and cleans up after unmount", async () => {
    const items = mount("right-top");
    await nextTick();
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    pointer(items[0], "pointerdown", 16, 16);
    pointer(window, "pointermove", 16, 198);
    callbacks.shift()?.(16);
    expect((container.querySelector("[data-shortcut-scroll]") as HTMLElement).scrollTop).toBeGreaterThan(0);
    app.unmount();
    pointer(window, "pointerup", 1, 1);
    expect(mocks.save).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it("reflects activity and hides empty or disabled bars and dividers", async () => {
    mount("sidebar-bottom");
    expect([...container.querySelectorAll("[data-shortcut-label]")].map((label) => label.textContent)).toEqual(["Function a", "Function b", "Function c"]);
    const buttons = container.querySelectorAll("button");
    expect(buttons[0].getAttribute("aria-pressed")).toBe("false");
    expect(buttons[1].getAttribute("aria-pressed")).toBe("true");
    expect(buttons[0].querySelector("[data-shortcut-active-indicator]")).toBeNull();
    expect(buttons[1].querySelector("[data-shortcut-active-indicator]")?.classList.contains("bg-green-500")).toBe(true);
    expect(container.querySelector('[role="separator"]')).not.toBeNull();
    mocks.state.editorSettings.pluginShortcuts.enabled = false;
    await nextTick();
    expect(container.querySelector("nav")).toBeNull();
    mocks.state.editorSettings.pluginShortcuts.enabled = true;
    mocks.entries.value = [];
    mocks.allEntries.value = [];
    await nextTick();
    expect(container.querySelector("nav")).toBeNull();
  });
});
