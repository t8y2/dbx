// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PluginShortcutBar from "./PluginShortcutBar.vue";
import { normalizePluginShortcutSettings, type PluginShortcutPosition } from "@/lib/plugins/pluginShortcuts";

const mocks = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn(), toast: vi.fn(), state: null as any, entries: null as any }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => mocks.state }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/composables/usePluginShortcuts", () => ({ usePluginShortcuts: () => ({ entries: mocks.entries, open: mocks.open, isActive: (entry: any) => entry.id === "b" }) }));
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
  mocks.state = reactive({ isEditorSettingsLoaded: true, editorSettings: { pluginShortcuts: normalizePluginShortcutSettings({}) }, updateEditorSettingsAndPersist: mocks.save });
  mocks.entries = ref(["a", "b", "c"].map((id) => ({ id, pluginId: id, label: `Function ${id}`, pluginName: `Plugin ${id}`, kind: "workbench", targetId: id, disabled: false })));
  mocks.save.mockResolvedValue(undefined);
});
afterEach(() => {
  app?.unmount();
  container?.remove();
});

describe("plugin shortcut bar", () => {
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
    expect(mocks.save).toHaveBeenCalledWith({ pluginShortcuts: { ...normalizePluginShortcutSettings({}), order: ["c", "a", "b"] } });
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
    await nextTick();
    expect(container.querySelector("nav")).toBeNull();
  });
});
