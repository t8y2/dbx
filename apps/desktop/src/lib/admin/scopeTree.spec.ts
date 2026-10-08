import { describe, expect, it } from "vitest";
import type { AdminScope, ScopeTreeNode } from "@/lib/admin/adminApi";
import { filterScopeTree, scopeNodeStateInTree, toggleScopeNode } from "@/lib/admin/scopeTree";

const tree: ScopeTreeNode[] = [
  {
    type: "group",
    id: "root",
    name: "Production",
    children: [
      { type: "connection", id: "orders", name: "Orders" },
      {
        type: "group",
        id: "analytics",
        name: "Analytics",
        children: [
          { type: "connection", id: "events", name: "Events" },
          { type: "connection", id: "metrics", name: "Metrics" },
        ],
      },
    ],
  },
  { type: "connection", id: "local", name: "Local" },
];

const emptyScope = (): AdminScope => ({ allowed_group_ids: [], allowed_connection_ids: [] });

describe("admin scope tree selection", () => {
  it("selects a group as one compact grant and makes descendants effective", () => {
    const scope = toggleScopeNode(tree, emptyScope(), "group", "root");

    expect(scope).toEqual({ allowed_group_ids: ["root"], allowed_connection_ids: [] });
    expect(scopeNodeStateInTree(tree, scope, "connection", "events")).toBe("checked");
  });

  it("shows a parent as indeterminate after selecting one descendant", () => {
    const scope = toggleScopeNode(tree, emptyScope(), "connection", "events");

    expect(scopeNodeStateInTree(tree, scope, "group", "analytics")).toBe("indeterminate");
    expect(scopeNodeStateInTree(tree, scope, "group", "root")).toBe("indeterminate");
  });

  it("materializes sibling grants when a child is removed from a selected group", () => {
    const selected = toggleScopeNode(tree, emptyScope(), "group", "root");
    const scope = toggleScopeNode(tree, selected, "connection", "events");

    expect(scope.allowed_group_ids).toEqual([]);
    expect(scope.allowed_connection_ids.sort()).toEqual(["metrics", "orders"]);
    expect(scopeNodeStateInTree(tree, scope, "connection", "events")).toBe("unchecked");
    expect(scopeNodeStateInTree(tree, scope, "group", "root")).toBe("indeterminate");
  });

  it("keeps matching descendants and their ancestor groups during search", () => {
    expect(filterScopeTree(tree, "metrics")).toEqual([
      {
        type: "group",
        id: "root",
        name: "Production",
        children: [
          {
            type: "group",
            id: "analytics",
            name: "Analytics",
            children: [{ type: "connection", id: "metrics", name: "Metrics" }],
          },
        ],
      },
    ]);
  });
});
