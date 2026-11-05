// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import ConnectionGroupPath from "../ConnectionGroupPath.vue";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("recomputes middle elision on resize and path changes, then disconnects on unmount", async () => {
  let availableWidth = 20;
  let resize: () => void = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => availableWidth);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { width: this.textContent?.length ?? 0 } as DOMRect;
  });
  const state = reactive({ segments: ["Prod", "Asia", "Team", "Orders"], connectionName: "orders" });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(ConnectionGroupPath, { segments: state.segments, connectionName: state.connectionName }) });
  app.mount(host);
  await nextTick();
  const root = host.firstElementChild!;
  const visiblePath = root.querySelector<HTMLElement>("[data-connection-group-path]")!;
  const visibleLabel = () => visiblePath.textContent;
  try {
    expect(visibleLabel()).toBe("Prod/…/Orders");
    expect(root.getAttribute("aria-label")).toBe("Prod/Asia/Team/Orders/orders");
    // The visible path has no placeholder or assigned width of its own: the
    // separator and name immediately follow its actual rendered text.
    expect(visiblePath.children).toHaveLength(0);
    expect(visiblePath.className).toBe("shrink-0 text-muted-foreground");
    expect(visiblePath.nextElementSibling?.textContent).toBe("/");
    const connectionName = visiblePath.nextElementSibling?.nextElementSibling;
    expect(connectionName?.textContent).toBe("orders");
    expect(connectionName?.classList.contains("flex-1")).toBe(true);
    state.connectionName = "a-very-long-connection-name";
    await nextTick();
    expect(Array.from(visibleLabel()!).length).toBeLessThanOrEqual(9);
    expect(connectionName?.textContent).toBe(state.connectionName);
    availableWidth = 100;
    resize();
    await nextTick();
    expect(visibleLabel()).toBe("Prod/Asia/Team/Orders");
    availableWidth = 20;
    resize();
    await nextTick();
    expect(Array.from(visibleLabel()!).length).toBeLessThanOrEqual(9);
    state.connectionName = "orders";
    await nextTick();
    expect(visibleLabel()).toBe("Prod/…/Orders");
    availableWidth = 100;
    resize();
    await nextTick();
    state.segments = ["Dev", "Orders"];
    await nextTick();
    expect(visibleLabel()).toBe("Dev/Orders");
    expect(root.getAttribute("aria-label")).toBe("Dev/Orders/orders");
  } finally {
    app.unmount();
  }
  expect(disconnect).toHaveBeenCalledOnce();
});
