import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/types/database";
import { resolveSidebarDdlTargets } from "@/lib/sidebar/sidebarDdlTargets";

describe("sidebarDdlTargets", () => {
  it("resolves multi-select ddl targets in the same execution context", () => {
    const first: TreeNode = { id: "t1", label: "one", type: "table", connectionId: "c1", database: "db" };
    const second: TreeNode = { id: "t2", label: "two", type: "view", connectionId: "c1", database: "db" };
    const otherDb: TreeNode = { id: "t3", label: "three", type: "table", connectionId: "c1", database: "other" };
    const group: TreeNode = { id: "group", label: "Tables", type: "group-tables", children: [first, second, otherDb] };

    expect(resolveSidebarDdlTargets(first, [group], [second.id, first.id])).toEqual([first, second]);
    expect(resolveSidebarDdlTargets(first, [group], [otherDb.id, first.id, second.id])).toEqual([first, second]);
  });
});
