import { describe, expect, it } from "vitest";
import { sortSidebarTreeChildrenForParent } from "@/lib/sidebar/sidebarNodeOrdering";
import type { TreeNode } from "@/types/database";

describe("Meilisearch sidebar ordering", () => {
  it("keeps the single system-management node after all indexes", () => {
    const children: TreeNode[] = [
      { id: "system", label: "meilisearch.systemManagement", type: "meilisearch-system", connectionId: "c1" },
      { id: "z", label: "zebra", type: "elasticsearch-index", connectionId: "c1" },
      { id: "a", label: "alpha", type: "elasticsearch-index", connectionId: "c1" },
    ];
    const result = sortSidebarTreeChildrenForParent({ type: "connection" }, children, "meilisearch");
    expect(result.map((node) => node.id)).toEqual(["a", "z", "system"]);
    expect(result.filter((node) => node.type === "meilisearch-system")).toHaveLength(1);
  });
});
