// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive, ref } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import { useCursorFloatingPosition } from "../useCursorFloatingPosition";

let app: ReturnType<typeof createApp>;
let host: HTMLDivElement;
afterEach(() => {
  app?.unmount();
  host?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("remeasures content and window changes, limits long previews, and cleans up observers", async () => {
  vi.stubGlobal("innerWidth", 300);
  vi.stubGlobal("innerHeight", 200);
  let resized!: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const removeListener = vi.spyOn(window, "removeEventListener");
  let contentWidth = 180;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = Math.min(contentWidth, parseFloat(this.style.maxWidth.split(",")[1]));
    return { width, height: 32 } as DOMRect;
  });
  const cursor = reactive({ x: 290, y: 190 });
  const visible = ref(true);
  app = createApp({
    setup() {
      const preview = ref<HTMLElement | null>(null);
      const style = useCursorFloatingPosition(preview, cursor);
      return () => (visible.value ? h("div", { ref: preview, style: style.value }) : null);
    },
  });
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await nextTick();
  await nextTick();
  const preview = host.firstElementChild as HTMLElement;
  expect(preview.style.left).toBe("98px");
  expect(preview.style.top).toBe("146px");
  contentWidth = 1000;
  resized();
  await nextTick();
  expect(preview.style.left).toBe("8px");
  expect(preview.style.maxWidth).toBe("min(20rem, 284px)");
  vi.stubGlobal("innerWidth", 160);
  window.dispatchEvent(new Event("resize"));
  await nextTick();
  expect(preview.style.maxWidth).toBe("min(20rem, 144px)");
  expect(preview.style.left).toBe("8px");
  visible.value = false;
  await nextTick();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(removeListener).toHaveBeenCalledWith("resize", expect.any(Function));
});
