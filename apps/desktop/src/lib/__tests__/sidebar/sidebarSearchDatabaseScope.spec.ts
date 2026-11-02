import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/types/database";
import { isSidebarSearchPrunedDatabaseNode, resolveSidebarSearchDatabaseScope } from "@/lib/sidebar/sidebarSearchDatabaseScope";

const OPTIONS = {
  enabled: true,
  isChildrenLoaded: (nodeId: string) => nodeId.endsWith(":loaded"),
  openDatabaseKeys: new Set(["conn-1\x00tabbed"]),
};

function databaseNode(id: string, database: string, overrides: Partial<TreeNode> = {}): TreeNode {
  return { id, label: database, type: "database", connectionId: "conn-1", database, isExpanded: false, children: [], ...overrides };
}

function connectionNode(children: TreeNode[]): TreeNode {
  return { id: "conn-1", label: "prod", type: "connection", connectionId: "conn-1", isExpanded: true, children };
}

describe("resolveSidebarSearchDatabaseScope", () => {
  it("keeps the search unrestricted when the setting is disabled", () => {
    const node = connectionNode([databaseNode("conn-1:a", "a"), databaseNode("conn-1:b", "b")]);
    expect(resolveSidebarSearchDatabaseScope(node, { ...OPTIONS, enabled: false })).toBeNull();
  });

  it("does not open every database when none has been opened", () => {
    const databases = [databaseNode("conn-1:a", "a"), databaseNode("conn-1:b", "b")];
    const scope = resolveSidebarSearchDatabaseScope(connectionNode(databases), OPTIONS);
    expect(scope).toEqual(new Set());
    expect(databases.every((node) => isSidebarSearchPrunedDatabaseNode(node, scope))).toBe(true);
  });

  it("also restricts databases discovered after resolving an empty connection root", () => {
    const scope = resolveSidebarSearchDatabaseScope(connectionNode([]), OPTIONS);
    expect(isSidebarSearchPrunedDatabaseNode(databaseNode("conn-1:new", "new"), scope)).toBe(true);
  });

  it("keeps databases opened in the tree", () => {
    const node = connectionNode([databaseNode("conn-1:a:loaded", "a"), databaseNode("conn-1:b", "b")]);
    expect(resolveSidebarSearchDatabaseScope(node, OPTIONS)).toEqual(new Set(["conn-1:a:loaded"]));
  });

  it("keeps databases referenced by an open editor tab", () => {
    const node = connectionNode([databaseNode("conn-1:tabbed", "tabbed"), databaseNode("conn-1:b", "b")]);
    expect(resolveSidebarSearchDatabaseScope(node, OPTIONS)).toEqual(new Set(["conn-1:tabbed"]));
  });

  it("discovers nested database nodes below catalogs and skips their subtrees", () => {
    const nested = databaseNode("conn-1:cat:nested:loaded", "nested");
    const node = connectionNode([
      { id: "conn-1:cat", label: "cat", type: "doris-catalog", connectionId: "conn-1", catalog: "cat", isExpanded: true, children: [nested] },
      { id: "conn-1:other", label: "other", type: "doris-catalog", connectionId: "conn-1", catalog: "other", isExpanded: false, children: [databaseNode("conn-1:other:deep", "deep")] },
    ]);
    expect(resolveSidebarSearchDatabaseScope(node, OPTIONS)).toEqual(new Set(["conn-1:cat:nested:loaded"]));
  });

  it("keeps schema-mode trees searchable without database nodes", () => {
    const schemaNode: TreeNode = { id: "conn-1:public", label: "public", type: "schema", connectionId: "conn-1", database: "main", isExpanded: false, children: [] };
    const scope = resolveSidebarSearchDatabaseScope(connectionNode([schemaNode]), OPTIONS);
    expect(isSidebarSearchPrunedDatabaseNode(schemaNode, scope)).toBe(false);
  });
});

describe("isSidebarSearchPrunedDatabaseNode", () => {
  it.each([
    ["database outside the scope", databaseNode("conn-1:b", "b"), new Set(["conn-1:a"]), true],
    ["database inside the scope", databaseNode("conn-1:a", "a"), new Set(["conn-1:a"]), false],
    ["database when none is opened", databaseNode("conn-1:a", "a"), new Set<string>(), true],
    ["unrestricted scope", databaseNode("conn-1:b", "b"), null, false],
    ["non-database container", { id: "conn-1", label: "prod", type: "connection", connectionId: "conn-1", isExpanded: true, children: [] } as TreeNode, new Set(["conn-1:a"]), false],
  ] as const)("returns %expected when the node is a %s", (_name, node, scope, expected) => {
    expect(isSidebarSearchPrunedDatabaseNode(node, scope)).toBe(expected);
  });
});
