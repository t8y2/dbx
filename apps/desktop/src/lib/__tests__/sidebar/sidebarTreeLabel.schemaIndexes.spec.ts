import { describe, expect, it } from "vitest";
import { sidebarTreeDisplayLabel } from "@/lib/sidebar/sidebarTreeLabel";
import type { TreeNode } from "@/types/database";

describe("sidebar tree labels", () => {
  it("retains the schema index load-more label for rendering and width measurement", () => {
    const node: TreeNode = { id: "indexes-more", type: "load-more", label: "tree.loadMore", loadMore: { parentId: "schema", objectType: "INDEX", offset: 100, pageSize: 100 } };
    expect(sidebarTreeDisplayLabel(node, (key) => key)).toBe("tree.indexes · tree.loadMore");
    expect(sidebarTreeDisplayLabel({ ...node, loadMore: undefined }, (key) => key)).toBe("tree.loadMore");
  });
});
