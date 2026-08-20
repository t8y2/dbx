// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App, type Component } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataGridStructuredFilterRule } from "@/composables/useDataGridFilterBuilder";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@lucide/vue", () => {
  const icon = defineComponent({ setup: () => () => h("span") });
  return { Check: icon, Eye: icon, EyeOff: icon, GripVertical: icon, Plus: icon, Search: icon, Trash2: icon, X: icon };
});

function passthrough(tag = "div") {
  return defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => h(tag, attrs, [slots.default?.(), slots.footer?.()]);
    },
  });
}

vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("@/components/ui/input", () => ({ Input: passthrough("input") }));
vi.mock("@/components/ui/select", () => ({ Select: passthrough(), SelectContent: passthrough(), SelectItem: passthrough(), SelectTrigger: passthrough("button"), SelectValue: passthrough("span") }));

import DataGridFilterBuilder from "../DataGridFilterBuilder.vue";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

function rules(count: number): DataGridStructuredFilterRule[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `r${index + 1}`,
    columnName: `column_${index + 1}`,
    mode: "equals",
    rawValue: String(index + 1),
    rawEndValue: "",
    conjunction: "AND",
  }));
}

async function mountBuilder(ruleCount = 3) {
  const move = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const wrapper: Component = defineComponent({
    setup() {
      return () =>
        h("div", { "data-filter-rules-scroll": "" }, [
          h(DataGridFilterBuilder, {
            rules: rules(ruleCount),
            columns: rules(ruleCount).map((rule) => rule.columnName),
            filteredColumns: rules(ruleCount).map((rule) => rule.columnName),
            modeOptions: [{ value: "equals", labelKey: "equals" }],
            columnSearch: "",
            layout: "panel",
            showHeader: false,
            showFooter: false,
            onMove: move,
          }),
        ]);
    },
  });
  const app = createApp(wrapper);
  app.mount(host);
  mountedApps.push({ app, host });
  await nextTick();
  return { host, move };
}

function configureGeometry(host: HTMLElement, scrollerHeight = 120) {
  const scroller = host.querySelector<HTMLElement>("[data-filter-rules-scroll]")!;
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
  host.querySelectorAll<HTMLElement>(".filter-rule-row").forEach((row, index) => {
    row.getBoundingClientRect = () => domRect(index * 38 - scrollTop, index * 38 + 28 - scrollTop, 400);
  });
  return scroller;
}

function domRect(top: number, bottom: number, width: number): DOMRect {
  return {
    left: 0,
    right: width,
    top,
    bottom,
    width,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

function dispatchPointer(target: EventTarget, type: string, options: { pointerId?: number; clientX?: number; clientY: number }) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: options.pointerId ?? 1,
      clientX: options.clientX ?? 20,
      clientY: options.clientY,
    }),
  );
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

describe("DataGridFilterBuilder pointer dragging", () => {
  it("reorders rules with pointer events", async () => {
    const { host, move } = await mountBuilder();
    configureGeometry(host);
    const handle = host.querySelectorAll<HTMLButtonElement>("[data-filter-drag-handle]")[0];

    dispatchPointer(handle, "pointerdown", { clientY: 14 });
    dispatchPointer(window, "pointermove", { clientY: 100 });
    await nextTick();

    expect(document.body.style.userSelect).toBe("none");
    expect(host.querySelector('[data-drop-position="after"]')).not.toBeNull();
    dispatchPointer(window, "pointerup", { clientY: 100 });
    expect(move).toHaveBeenCalledOnce();
    expect(move).toHaveBeenCalledWith("r1", 2);
    expect(document.body.style.userSelect).toBe("");
  });

  it("cancels an active pointer drag on Escape", async () => {
    const { host, move } = await mountBuilder();
    configureGeometry(host);
    const handle = host.querySelectorAll<HTMLButtonElement>("[data-filter-drag-handle]")[0];

    dispatchPointer(handle, "pointerdown", { pointerId: 3, clientY: 14 });
    dispatchPointer(window, "pointermove", { pointerId: 3, clientY: 100 });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    dispatchPointer(window, "pointerup", { pointerId: 3, clientY: 100 });
    await nextTick();

    expect(move).not.toHaveBeenCalled();
    expect(host.querySelector("[data-drop-position]")).toBeNull();
    expect(document.body.style.cursor).toBe("");
  });

  it("auto-scrolls the condition list near its bottom edge", async () => {
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
    const handle = host.querySelectorAll<HTMLButtonElement>("[data-filter-drag-handle]")[0];

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
