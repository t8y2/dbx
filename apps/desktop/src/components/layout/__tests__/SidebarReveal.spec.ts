// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SidebarReveal from "../SidebarReveal.vue";
import { beginPanelResize, endPanelResize } from "@/lib/app/panelResizeState";

let app: ReturnType<typeof createApp>;
let host: HTMLDivElement;
let mountedCount: number;
const props = reactive({ pinned: false, enabled: true, classicLayout: false, hoverEnabled: true, hoverDelay: 300 });
const edge = () => host.querySelector<HTMLElement>("[data-sidebar-reveal-edge]")!;
const panel = () => host.querySelector<HTMLElement>("[data-sidebar-reveal-panel]")!;
const preview = () => panel().hasAttribute("data-sidebar-preview");
const pointer = (target: EventTarget, type: string, init: PointerEventInit = {}) => target.dispatchEvent(new PointerEvent(type, { pointerType: "mouse", ...init }));
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await nextTick();
}
async function reveal() {
  pointer(edge(), "pointerenter");
  await advance(props.hoverDelay);
  pointer(edge(), "pointerleave");
  pointer(panel(), "pointerenter");
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(props, { pinned: false, enabled: true, classicLayout: false, hoverEnabled: true, hoverDelay: 300 });
  mountedCount = 0;
  host = document.createElement("div");
  document.body.append(host);
  const Content = defineComponent({
    setup() {
      mountedCount++;
      return () => h("input", { value: "search" });
    },
  });
  app = createApp({ render: () => h(SidebarReveal, props, { default: () => h(Content) }) });
  app.mount(host);
});

afterEach(() => {
  app.unmount();
  endPanelResize();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("sidebar hover preview", () => {
  it("disables the edge without disabling manual expansion", async () => {
    props.hoverEnabled = false;
    await nextTick();
    expect(edge()).toBeNull();
    await advance(1000);
    expect(preview()).toBe(false);
    props.pinned = true;
    await nextTick();
    expect(panel().style.display).not.toBe("none");
    expect(mountedCount).toBe(1);
  });

  it("cancels a pending opening and an active preview when hover is disabled", async () => {
    pointer(edge(), "pointerenter");
    await advance(200);
    props.hoverEnabled = false;
    await advance(500);
    expect(preview()).toBe(false);
    props.hoverEnabled = true;
    await nextTick();
    await reveal();
    props.hoverEnabled = false;
    await nextTick();
    expect(preview()).toBe(false);
    expect(edge()).toBeNull();
  });

  it.each([100, 300, 750, 2000])("uses the configured %sms delay", async (delay) => {
    props.hoverDelay = delay;
    await nextTick();
    pointer(edge(), "pointerenter");
    await advance(delay - 1);
    expect(preview()).toBe(false);
    await advance(1);
    expect(preview()).toBe(true);
  });

  it("cancels stale opening timers when the delay changes", async () => {
    pointer(edge(), "pointerenter");
    await advance(200);
    props.hoverDelay = 1000;
    await advance(2000);
    expect(preview()).toBe(false);
    await reveal();
    expect(preview()).toBe(true);
  });

  it("requires a 300ms dwell and cancels when passing the edge", async () => {
    pointer(edge(), "pointerenter");
    await advance(299);
    expect(preview()).toBe(false);
    pointer(edge(), "pointerleave");
    await advance(400);
    expect(preview()).toBe(false);
    await reveal();
    expect(preview()).toBe(true);
    expect(props.pinned).toBe(false);
    expect(panel().classList.contains("sidebar-reveal-overlay")).toBe(true);
    // 壁纸模式下悬停浮出面板必须保持不透明（--background-solid，#14219）。
    expect(panel().classList.contains("bg-background-solid")).toBe(true);
  });

  it("closes after 300ms outside and cancels closing on re-entry", async () => {
    await reveal();
    pointer(panel(), "pointerleave");
    await advance(299);
    expect(preview()).toBe(true);
    pointer(panel(), "pointerenter");
    await advance(500);
    expect(preview()).toBe(true);
    pointer(panel(), "pointerleave");
    await advance(300);
    expect(preview()).toBe(false);
    await advance(200);
    expect(panel().style.display).toBe("none");
  });

  it.each(["[data-dbx-context-menu]", '[role="menu"]', '[role="listbox"]', '[role="dialog"]', '[role="alertdialog"]'])("holds while a teleported %s is open, then closes without another mouse move", async (selector) => {
    await reveal();
    const surface = document.createElement("div");
    if (selector.startsWith("[role")) surface.setAttribute("role", selector.split('"')[1]!);
    else surface.setAttribute("data-dbx-context-menu", "");
    document.body.append(surface);
    pointer(panel(), "pointerleave");
    await advance(1000);
    expect(preview()).toBe(true);
    surface.remove();
    await advance(100);
    expect(preview()).toBe(false);
  });

  it("ignores closed/hidden menus and tooltips", async () => {
    await reveal();
    const hidden = document.createElement("div");
    hidden.style.display = "none";
    hidden.innerHTML = '<div role="menu"></div>';
    document.body.append(hidden);
    const tooltip = document.createElement("div");
    tooltip.setAttribute("role", "tooltip");
    document.body.append(tooltip);
    pointer(panel(), "pointerleave");
    await advance(300);
    expect(preview()).toBe(false);
  });

  it("keeps the sidebar open throughout resizing and pointer dragging", async () => {
    await reveal();
    beginPanelResize();
    pointer(panel(), "pointerleave");
    await advance(1000);
    expect(preview()).toBe(true);
    endPanelResize();
    await advance(300);
    expect(preview()).toBe(false);
    await reveal();
    pointer(panel(), "pointerdown");
    pointer(panel(), "pointerleave");
    await advance(1000);
    expect(preview()).toBe(true);
    pointer(document, "pointerup");
    await advance(300);
    expect(preview()).toBe(false);
  });

  it("pins without remounting content or losing its state", async () => {
    await reveal();
    const input = host.querySelector("input")!;
    input.value = "users";
    props.pinned = true;
    await nextTick();
    expect(edge()).toBeNull();
    expect(preview()).toBe(false);
    expect(panel().classList.contains("sidebar-reveal-overlay")).toBe(false);
    pointer(panel(), "pointerleave");
    await advance(1000);
    expect(panel().style.display).not.toBe("none");
    expect(host.querySelector("input")).toBe(input);
    expect(input.value).toBe("users");
    expect(mountedCount).toBe(1);
    props.pinned = false;
    await nextTick();
    expect(preview()).toBe(false);
  });

  it("disables reveal and cancels pending opening in zen mode", async () => {
    pointer(edge(), "pointerenter");
    props.enabled = false;
    await advance(200);
    expect(edge()).toBeNull();
    expect(preview()).toBe(false);
    props.enabled = true;
    await nextTick();
    await reveal();
    props.enabled = false;
    await nextTick();
    expect(preview()).toBe(false);
  });

  it("does not trigger from touch or a drag entering the edge", async () => {
    pointer(edge(), "pointerenter", { pointerType: "touch" });
    await advance(200);
    expect(preview()).toBe(false);
    pointer(edge(), "pointerenter", { buttons: 1 });
    await advance(200);
    expect(preview()).toBe(false);
  });

  it("supports classic layout, closes on window blur and releases timers on unmount", async () => {
    props.classicLayout = true;
    await nextTick();
    await reveal();
    expect(panel().classList.contains("sidebar-reveal-inset")).toBe(false);
    window.dispatchEvent(new Event("blur"));
    await nextTick();
    expect(preview()).toBe(false);
    await reveal();
    pointer(panel(), "pointerleave");
    app.unmount();
    await advance(500);
    expect(vi.getTimerCount()).toBe(0);
  });
});
