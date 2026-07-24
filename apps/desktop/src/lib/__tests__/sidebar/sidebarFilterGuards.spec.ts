import { readFileSync } from "node:fs";
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

  it("keeps descendant-local features separate from partial-root operations", () => {
    const source = readFileSync(new URL("../../../components/sidebar/ConnectionTree.vue", import.meta.url), "utf8");

    expect(source).toContain("sidebarTableSearchEnabled && !isTreeSearchFiltering.value");
    expect(source).toContain("!useVirtualTree.value || isTreeSearchFiltering.value");
    expect(source.match(/if \(isRootListPartial\.value\)/g)).toHaveLength(2);
    expect(source.match(/:drag-disabled="isRootListPartial \|\| isConnectionListAlphabeticallySorted"/g)).toHaveLength(2);
    expect(source).not.toContain("isFiltering");
  });
});
