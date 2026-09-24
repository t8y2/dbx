// @vitest-environment happy-dom
import { createApp, effectScope, h, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePluginShortcutHeight } from "../usePluginShortcutHeight";
import { isPanelResizing } from "@/lib/app/panelResizeState";

let app: ReturnType<typeof createApp>;
let resizeObserver: () => void;
let root: HTMLElement;
afterEach(() => {
  app?.unmount();
  root?.remove();
  vi.unstubAllGlobals();
});
async function setup() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resizeObserver = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  root = document.createElement("div");
  root.innerHTML = '<div></div><nav><div data-shortcut-resize></div><div style="padding:4px"><div style="gap:0px"><span data-shortcut-id="a"></span></div></div></nav>';
  document.body.append(root);
  const tree = root.children[0] as HTMLElement;
  const section = root.children[1] as HTMLElement;
  const handle = section.children[0] as HTMLElement;
  const scroll = section.children[1] as HTMLElement;
  let width = 184;
  let total = 600;
  const count = ref(10);
  const savedHeight = ref<number | null>(null);
  const sectionRef = ref<HTMLElement | null>(null);
  const scrollRef = ref<HTMLElement | null>(null);
  let sizing!: ReturnType<typeof usePluginShortcutHeight>;
  const save = vi.fn(async (height: number | null) => {
    savedHeight.value = height;
  });
  app = createApp({
    setup() {
      sizing = usePluginShortcutHeight({ section: sectionRef, scroll: scrollRef, sidebarList: ref(true), count, savedHeight, save });
      return () => h("div");
    },
  });
  app.mount(document.createElement("div"));
  Object.defineProperty(tree, "offsetHeight", { get: () => total - sizing.height.value - 6 });
  Object.defineProperty(section, "offsetHeight", { get: () => sizing.height.value + 6 });
  Object.defineProperty(handle, "offsetHeight", { get: () => 6 });
  Object.defineProperty(scroll, "clientWidth", { get: () => width });
  section.getBoundingClientRect = () => ({ height: sizing.height.value + 6 }) as DOMRect;
  sectionRef.value = section;
  scrollRef.value = scroll;
  await nextTick();
  await nextTick();
  handle.addEventListener("pointerdown", sizing.start);
  const pointer = (target: EventTarget, type: string, y: number) => target.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientY: y, bubbles: true, cancelable: true }));
  return {
    sizing,
    savedHeight,
    count,
    save,
    handle,
    pointer,
    setWidth: (next: number) => {
      width = next;
      resizeObserver();
    },
    setTotal: (next: number) => {
      total = next;
      resizeObserver();
    },
  };
}
describe("shortcut sidebar height", () => {
  it("does not attach a resize observer after disposal during a pending measurement", async () => {
    const observe = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = observe;
        disconnect() {}
      },
    );
    const section = ref<HTMLElement | null>(null);
    const scope = effectScope();
    scope.run(() => usePluginShortcutHeight({ section, scroll: ref(null), sidebarList: ref(true), count: ref(1), savedHeight: ref(null), save: vi.fn() }));
    root = document.createElement("div");
    root.innerHTML = "<nav></nav>";
    section.value = root.firstElementChild as HTMLElement;
    await nextTick();
    scope.stop();
    await nextTick();
    expect(observe).not.toHaveBeenCalled();
  });
  it("keeps one entry per row regardless of width, remembers manual height and resets to automatic", async () => {
    const { sizing, count, savedHeight, setWidth } = await setup();
    expect(sizing.height.value).toBe(148);
    setWidth(112);
    expect(sizing.height.value).toBe(148);
    count.value = 40;
    expect(sizing.height.value).toBe(148);
    savedHeight.value = 250;
    expect(sizing.height.value).toBe(250);
    count.value = 2;
    expect(sizing.height.value).toBe(250);
    await sizing.reset();
    expect(savedHeight.value).toBeNull();
    expect(sizing.height.value).toBe(64);
  });
  it("saves only on release and reserves space for the tree", async () => {
    const { sizing, handle, pointer, save, setTotal } = await setup();
    pointer(handle, "pointerdown", 500);
    pointer(window, "pointermove", 400);
    expect(sizing.height.value).toBe(248);
    expect(save).not.toHaveBeenCalled();
    pointer(window, "pointerup", 400);
    await nextTick();
    expect(save).toHaveBeenCalledWith(248);
    expect(isPanelResizing.value).toBe(false);
    setTotal(250);
    expect(sizing.height.value).toBe(124);
  });
  it.each(["blur", "pointercancel", "escape"])("restores the original height on %s", async (reason) => {
    const { sizing, handle, pointer, save } = await setup();
    pointer(handle, "pointerdown", 500);
    pointer(window, "pointermove", 400);
    window.dispatchEvent(reason === "escape" ? new KeyboardEvent("keydown", { key: "Escape" }) : new Event(reason));
    expect(sizing.height.value).toBe(148);
    expect(save).not.toHaveBeenCalled();
    expect(isPanelResizing.value).toBe(false);
  });
});
