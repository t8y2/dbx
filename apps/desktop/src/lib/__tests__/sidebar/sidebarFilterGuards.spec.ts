import { describe, expect, it } from "vitest";
import { resolveSidebarFilterGuards } from "@/lib/sidebar/sidebarSearchTree";

describe("sidebar filter guards", () => {
  it.each([
    { connectedOnly: false, query: "", scoped: false, treeSearch: false, rootPartial: false },
    { connectedOnly: true, query: "", scoped: false, treeSearch: false, rootPartial: true },
    { connectedOnly: false, query: "table", scoped: false, treeSearch: true, rootPartial: true },
    { connectedOnly: true, query: "table", scoped: false, treeSearch: true, rootPartial: true },
    { connectedOnly: false, query: "   ", scoped: true, treeSearch: true, rootPartial: true },
    { connectedOnly: true, query: "   ", scoped: true, treeSearch: true, rootPartial: true },
    { connectedOnly: false, query: "table", scoped: true, treeSearch: true, rootPartial: true },
    { connectedOnly: true, query: "table", scoped: true, treeSearch: true, rootPartial: true },
  ])("separates connected-only=$connectedOnly query=$query scoped=$scoped", ({ connectedOnly, query, scoped, treeSearch, rootPartial }) => {
    expect(resolveSidebarFilterGuards(connectedOnly, query, scoped)).toEqual({
      isTreeSearchFiltering: treeSearch,
      isRootListPartial: rootPartial,
    });
  });
});
