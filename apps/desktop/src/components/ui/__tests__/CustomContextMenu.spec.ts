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
  it("removes the capture keydown listener when unmounted while open", async () => {
    const documentAdd = vi.spyOn(document, "addEventListener");
    const documentRemove = vi.spyOn(document, "removeEventListener");
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

    container.querySelector("#context-target")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await nextTick();
    const keydownListener = callsFor(documentAdd, "keydown").at(-1)?.[1];
    expect(keydownListener).toBeTruthy();

    app.unmount();
    await nextTick();

    expect(documentRemove.mock.calls).toContainEqual(["keydown", keydownListener, true]);
  });

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

  it("closes the menu when an application shortcut is pressed", async () => {
    const root = defineComponent({
      setup() {
        return () =>
          h(
            CustomContextMenu,
            { items: [{ label: "Refresh row" }] },
            {
              default: ({ onContextMenu }: { onContextMenu: (event: MouseEvent) => void }) => h("div", { id: "context-target", onContextmenu: onContextMenu, onKeydown: (event: KeyboardEvent) => event.stopPropagation() }, "Target"),
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
    target?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await nextTick();
    expect(document.body.textContent).toContain("Refresh row");

    target?.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true, bubbles: true }));
    await nextTick();
    expect(document.body.textContent).toContain("Refresh row");

    target?.dispatchEvent(new KeyboardEvent("keydown", { key: "r", metaKey: true, bubbles: true }));
    await nextTick();
    expect(document.body.textContent).not.toContain("Refresh row");

    app.unmount();
  });

  it("renders checked state in the leading icon slot", async () => {
    const root = defineComponent({
      setup() {
        return () =>
          h(
            CustomContextMenu,
            { items: [{ label: "Current", checked: true }, { label: "Other" }] },
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

    container.querySelector("#context-target")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await nextTick();

    const current = Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.includes("Current"));
    const other = Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.includes("Other"));
    expect(current?.firstElementChild?.querySelector("svg")).not.toBeNull();
    expect(current?.lastElementChild?.tagName.toLowerCase()).toBe("span");
    expect(other?.querySelector("svg")).toBeNull();

    app.unmount();
  });

  it("resolves lazy menu items again for every open", async () => {
    let copied = false;
    const items = vi.fn(() =>
      copied
        ? [
            {
              label: "Paste Table",
              action: () => {
                copied = false;
              },
            },
          ]
        : [
            {
              label: "Copy Table",
              action: () => {
                copied = true;
              },
            },
          ],
    );
    const root = defineComponent({
      setup() {
        return () =>
          h(
            CustomContextMenu,
            { items },
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
    target?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await nextTick();
    expect(document.body.textContent).toContain("Copy Table");

    const copyAction = Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.includes("Copy Table"));
    copyAction?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(copied).toBe(true);

    target?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await nextTick();
    expect(document.body.textContent).toContain("Paste Table");
    expect(document.body.textContent).not.toContain("Copy Table");

    const pasteAction = Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.includes("Paste Table"));
    pasteAction?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(copied).toBe(false);

    target?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await nextTick();
    expect(document.body.textContent).toContain("Copy Table");
    expect(document.body.textContent).not.toContain("Paste Table");
    expect(items).toHaveBeenCalledTimes(3);

    app.unmount();
  });

  it("keeps the menu open when scrolling inside a scrollable submenu", async () => {
    const children = Array.from({ length: 40 }, (_, index) => ({ label: `Copy option ${index}` }));
    const root = defineComponent({
      setup() {
        return () =>
          h(
            CustomContextMenu,
            { items: [{ label: "Copy", children }] },
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

    const copyTrigger = Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.includes("Copy"));
    expect(copyTrigger).toBeTruthy();
    copyTrigger?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, clientX: 20, clientY: 30 }));
    await nextTick();

    const submenu = Array.from(document.body.querySelectorAll("[data-dbx-context-menu]")).find((el) => el.textContent?.includes("Copy option 0"));
    expect(submenu).toBeTruthy();
    submenu?.dispatchEvent(new Event("scroll", { bubbles: true }));
    await nextTick();
    expect(document.body.textContent).toContain("Copy option 0");

    document.dispatchEvent(new Event("scroll", { bubbles: true }));
    await nextTick();
    expect(document.body.textContent).not.toContain("Copy option 0");

    app.unmount();
  });
});
