import { describe, expect, it } from "vitest";
import { filterSidebarTree } from "@/lib/sidebar/sidebarSearchTree";
import type { TreeNode, TreeNodeType } from "@/types/database";

function tree(connectionId = "c", includeObject = true): TreeNode {
  return {
    id: connectionId,
    type: "connection",
    label: "Connection",
    connectionId,
    children: [
      { id: `${connectionId}-scope`, type: "relational-scope", label: "schema", connectionId, relationalNavigationContainer: { connectionId, kind: "schema" }, relationalNavigationOptions: ["A", "B"], relationalNavigationSelection: { kind: "named", name: "A" } },
      ...(includeObject ? [{ id: `${connectionId}-tables`, type: "group-tables" as const, label: "Tables", connectionId, children: [{ id: `${connectionId}-table`, type: "table" as const, label: "NAV_SAME", connectionId, database: "DB", schema: "A" }] }] : []),
    ],
  };
}

describe("relational scope controls during sidebar search", () => {
  it.each([false, true])("retains the scope choices beside filtered objects with regex=%s", (regexMode) => {
    const nodes = [tree()];
    const before = JSON.stringify(nodes);
    const result = filterSidebarTree(nodes, regexMode ? "^NAV_SAME$" : "NAV_SAME", new Set(), undefined, { regexMode, scopeControlConnectionIds: new Set(["c"]) });
    expect(result[0].children?.map((node) => node.type)).toEqual(["relational-scope", "group-tables"]);
    expect(result[0].children?.[0].relationalNavigationOptions).toEqual(["A", "B"]);
    expect(result[0].children?.[1].children?.[0].schema).toBe("A");
    expect(JSON.stringify(nodes)).toBe(before);
  });
  it("keeps the connected picker usable with no matches without adding an unrelated offline root", () => {
    const result = filterSidebarTree([tree(), tree("offline", false)], "NO_MATCH", new Set(), undefined, { scopeControlConnectionIds: new Set(["c"]) });
    expect(result.map((node) => node.id)).toEqual(["c"]);
    expect(result[0].children?.map((node) => node.type)).toEqual(["relational-scope"]);
  });
  it("does not let the control bypass an object type filter", () => {
    const result = filterSidebarTree([tree()], "NAV_SAME", new Set(), new Set<TreeNodeType>(["view"]), { scopeControlConnectionIds: new Set(["c"]) });
    expect(result[0].children?.map((node) => node.type)).toEqual(["relational-scope"]);
  });
});
