// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick } from "vue";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import JsonTree from "../JsonTree.vue";

// vue-virtual-scroller observes item sizes; happy-dom has no layout engine.
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function mountTree(props: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(defineComponent({ render: () => h(JsonTree, props) }));
  app.mount(host);
  return host;
}

describe("JsonTree", () => {
  it("renders fully expanded nested children by default", async () => {
    const host = mountTree({ value: { outer: { inner: 1 } } });
    await nextTick();

    const root = host.querySelector(".json-tree");
    expect(root).not.toBeNull();
    expect(root?.classList.contains("is-virtualized")).toBe(false);
    // The recursive branch nests expanded container children.
    expect(root?.querySelector(".json-tree-children")).not.toBeNull();
  });

  it("renders flat virtualized rows and keeps node toggles working", async () => {
    const host = mountTree({ value: { outer: { inner: 1 } }, virtualized: true });
    await nextTick();
    await nextTick();

    const root = host.querySelector(".json-tree");
    expect(root?.classList.contains("is-virtualized")).toBe(true);
    expect(root?.querySelector(".json-tree-scroller")).not.toBeNull();
    // The virtual branch flattens containers; closing brackets become rows.
    expect(root?.querySelector(".json-tree-children")).toBeNull();
    expect(root?.querySelector(".json-tree-closing")).not.toBeNull();

    const toggle = root?.querySelector<HTMLButtonElement>(".json-tree-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    toggle?.click();
    await nextTick();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  });
});
