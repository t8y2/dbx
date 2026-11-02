// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App, type Component } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataGridStructuredSortRule } from "@/composables/useDataGridSortBuilder";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@lucide/vue", () => {
  const icon = defineComponent({ setup: () => () => h("span") });
  return { ArrowDown: icon, ArrowUp: icon, Check: icon, Eye: icon, EyeOff: icon, Focus: icon, GripVertical: icon, Plus: icon, Search: icon, Trash2: icon, X: icon };
});

function passthrough(tag = "div") {
  return defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => h(tag, attrs, [slots.default?.(), slots.header?.()]);
    },
  });
}

vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("@/components/ui/select", () => ({ Select: passthrough(), SelectContent: passthrough(), SelectItem: passthrough(), SelectTrigger: passthrough("button"), SelectValue: passthrough("span") }));
vi.mock("@/components/ui/LightTooltip.vue", () => ({ default: passthrough() }));

import DataGridSortBuilder from "../DataGridSortBuilder.vue";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

function rules(count: number): DataGridStructuredSortRule[] {
  return Array.from({ length: count }, (_, index) => ({ id: `r${index + 1}`, columnName: `column_${index + 1}`, direction: index % 2 ? "desc" : "asc" }));
}

async function mountBuilder(ruleCount = 3) {
  const move = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const wrapper: Component = defineComponent({
    setup() {
      const items = rules(ruleCount);
      return () => h("div", { "data-sort-rules-scroll": "" }, [h(DataGridSortBuilder, { rules: items, columns: items.map((rule) => rule.columnName), onMove: move })]);
    },
  });
  const app = createApp(wrapper);
  app.mount(host);
  mountedApps.push({ app, host });
  await nextTick();
  return { host, move };
}

function domRect(top: number, bottom: number, width: number): DOMRect {
  return { left: 0, right: width, top, bottom, width, height: bottom - top, x: 0, y: top, toJSON: () => ({}) };
}

function configureGeometry(host: HTMLElement, scrollerHeight = 120) {
  const scroller = host.querySelector<HTMLElement>("[data-sort-rules-scroll]")!;
  let scrollTop = 0;
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: scrollerHeight },
    scrollHeight: { configurable: true, value: 400 },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(400 - scrollerHeight, value));
      },
    },
  });
  scroller.getBoundingClientRect = () => domRect(0, scrollerHeight, 400);
  host.querySelectorAll<HTMLElement>(".sort-rule-row").forEach((row, index) => {
    row.getBoundingClientRect = () => domRect(index * 38 - scrollTop, index * 38 + 28 - scrollTop, 400);
  });
  return scroller;
}

function dispatchPointer(target: EventTarget, type: string, options: { pointerId?: number; clientX?: number; clientY: number }) {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: options.pointerId ?? 1, clientX: options.clientX ?? 20, clientY: options.clientY }));
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  document.body.innerHTML = "";
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DataGridSortBuilder pointer dragging", () => {
  it("reorders sort fields by dragging the handle", async () => {
    const { host, move } = await mountBuilder();
    configureGeometry(host);
    const handles = host.querySelectorAll<HTMLButtonElement>("[data-sort-drag-handle]");
    expect(handles.length).toBeGreaterThan(0);
    const handle = handles[0]!;

    dispatchPointer(handle, "pointerdown", { clientY: 14 });
    dispatchPointer(window, "pointermove", { clientY: 100 });
    await nextTick();

    expect(document.body.style.userSelect).toBe("none");
    expect(host.querySelector('[data-drop-position="after"]')).not.toBeNull();
    dispatchPointer(window, "pointerup", { clientY: 100 });
    expect(move).toHaveBeenCalledWith("r1", 2);
    expect(document.body.style.userSelect).toBe("");
  });

  it("auto-scrolls a long sort rule list while dragging near the bottom", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        const frameId = nextFrameId++;
        frames.set(frameId, callback);
        return frameId;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((frameId: number) => frames.delete(frameId)),
    );
    const { host, move } = await mountBuilder(10);
    const scroller = configureGeometry(host, 100);
    const handles = host.querySelectorAll<HTMLButtonElement>("[data-sort-drag-handle]");
    expect(handles.length).toBeGreaterThan(0);
    const handle = handles[0]!;

    dispatchPointer(handle, "pointerdown", { pointerId: 7, clientY: 14 });
    dispatchPointer(window, "pointermove", { pointerId: 7, clientY: 96 });
    for (let frameIndex = 0; frameIndex < 8; frameIndex += 1) {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(frameIndex));
    }

    expect(scroller.scrollTop).toBeGreaterThan(0);
    dispatchPointer(window, "pointercancel", { pointerId: 7, clientY: 96 });
    expect(move).not.toHaveBeenCalled();
  });
});
