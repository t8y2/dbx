// @vitest-environment happy-dom

import { createApp, h, nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";

vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: (key: string) => key }),
}));

import QueryResultViewSwitcher from "@/components/layout/QueryResultViewSwitcher.vue";

function mount(props: Record<string, unknown>) {
  const root = document.createElement("div");
  const events: Array<[string, unknown]> = [];
  createApp({
    render: () =>
      h(QueryResultViewSwitcher, {
        activeView: "result",
        canShowResult: true,
        canShowSummary: true,
        canShowChart: false,
        canShowMessages: false,
        ...props,
        onSelectView: (view: unknown) => events.push(["selectView", view]),
        onSelectMongoTree: (tree: unknown) => events.push(["selectMongoTree", tree]),
      }),
  }).mount(root);
  return { root, events };
}

describe("QueryResultViewSwitcher MongoDB tree", () => {
  it("hides the Tree button for non-document results", async () => {
    const { root } = mount({});
    await nextTick();
    expect(root.querySelector("[data-mongo-result-tree]")).toBeNull();
  });

  it("switches between Table Data and Tree", async () => {
    const { root, events } = mount({ canShowMongoTree: true, mongoTree: false });
    await nextTick();
    const tree = root.querySelector<HTMLButtonElement>("[data-mongo-result-tree]")!;
    expect(tree.getAttribute("aria-pressed")).toBe("false");
    tree.click();
    expect(events).toEqual([["selectMongoTree", true]]);
  });

  it("leaves the Tree view when Table Data is clicked", async () => {
    const { root, events } = mount({ canShowMongoTree: true, mongoTree: true });
    await nextTick();
    expect(root.querySelector("[data-mongo-result-tree]")!.getAttribute("aria-pressed")).toBe("true");
    root.querySelector<HTMLButtonElement>("button")!.click();
    expect(events).toEqual([["selectMongoTree", false]]);
  });
});
