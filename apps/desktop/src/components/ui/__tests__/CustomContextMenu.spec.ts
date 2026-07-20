// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import CustomContextMenu from "@/components/ui/CustomContextMenu.vue";

function callsFor(spy: ReturnType<typeof vi.spyOn>, eventName: string) {
  return spy.mock.calls.filter(([name]) => name === eventName);
}

function removalsForListener(spy: ReturnType<typeof vi.spyOn>, eventName: string, listener: unknown) {
  return spy.mock.calls.filter(([name, candidate]) => name === eventName && candidate === listener);
}

const mountedContainers: HTMLElement[] = [];

afterEach(() => {
  for (const container of mountedContainers.splice(0)) container.remove();
  vi.restoreAllMocks();
});

describe("CustomContextMenu lifecycle", () => {
  it("uses one shared listener set across repeated bulk mount cycles", async () => {
    const documentAdd = vi.spyOn(document, "addEventListener");
    const documentRemove = vi.spyOn(document, "removeEventListener");
    const windowAdd = vi.spyOn(window, "addEventListener");
    const windowRemove = vi.spyOn(window, "removeEventListener");

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const root = defineComponent({
        setup() {
          return () =>
            Array.from({ length: 200 }, (_, index) =>
              h(
                CustomContextMenu,
                { items: [{ label: `Action ${index}` }] },
                {
                  default: ({ onContextMenu }: { onContextMenu: (event: MouseEvent) => void }) => h("div", { onContextmenu: onContextMenu }, `Target ${index}`),
                },
              ),
            );
        },
      });
      const container = document.createElement("div");
      mountedContainers.push(container);
      document.body.append(container);
      const app = createApp(root);

      app.mount(container);
      await nextTick();
      expect(callsFor(documentAdd, "contextmenu")).toHaveLength(cycle);
      expect(callsFor(documentAdd, "scroll")).toHaveLength(cycle);
      expect(callsFor(windowAdd, "resize")).toHaveLength(cycle);
      const contextMenuListener = callsFor(documentAdd, "contextmenu")[cycle - 1][1];
      const scrollListener = callsFor(documentAdd, "scroll")[cycle - 1][1];
      const resizeListener = callsFor(windowAdd, "resize")[cycle - 1][1];
      const contextMenuRemovals = removalsForListener(documentRemove, "contextmenu", contextMenuListener).length;
      const scrollRemovals = removalsForListener(documentRemove, "scroll", scrollListener).length;
      const resizeRemovals = removalsForListener(windowRemove, "resize", resizeListener).length;

      app.unmount();
      await nextTick();
      expect(removalsForListener(documentRemove, "contextmenu", contextMenuListener)).toHaveLength(contextMenuRemovals + 1);
      expect(removalsForListener(documentRemove, "scroll", scrollListener)).toHaveLength(scrollRemovals + 1);
      expect(removalsForListener(windowRemove, "resize", resizeListener)).toHaveLength(resizeRemovals + 1);
    }
  });

  it("preserves open and global close behavior", async () => {
    const root = defineComponent({
      setup() {
        return () =>
          h(
            CustomContextMenu,
            { items: [{ label: "Inspect" }] },
            {
              default: ({ onContextMenu }: { onContextMenu: (event: MouseEvent) => void }) => h("div", { id: "context-target", onContextmenu: onContextMenu }, "Target"),
            },
          );
      },
    });
    const container = document.createElement("div");
    mountedContainers.push(container);
    document.body.append(container);
    const app = createApp(root);
    app.mount(container);

    const target = container.querySelector("#context-target");
    target?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 20 }));
    await nextTick();
    expect(document.body.textContent).toContain("Inspect");

    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect(document.body.textContent).not.toContain("Inspect");

    app.unmount();
  });
});
