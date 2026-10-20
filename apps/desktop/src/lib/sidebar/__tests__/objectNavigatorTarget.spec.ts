import { describe, expect, it } from "vitest";
import { objectNavigatorTargetForTreeNode } from "../objectNavigatorTarget";
import type { TreeNode } from "@/types/database";

function node(type: TreeNode["type"], extras: Partial<TreeNode> = {}): TreeNode {
  return { id: type, label: type, type, connectionId: "conn", database: "app", ...extras };
}

describe("objectNavigatorTargetForTreeNode", () => {
  it("shows databases for a connection and all objects for a database", () => {
    expect(objectNavigatorTargetForTreeNode(node("connection"))).toMatchObject({ database: "", filter: "all" });
    expect(objectNavigatorTargetForTreeNode(node("database"))).toMatchObject({ database: "app", filter: "all" });
  });

  it("maps object groups to the corresponding list", () => {
    expect(objectNavigatorTargetForTreeNode(node("group-tables"))?.filter).toBe("tables");
    expect(objectNavigatorTargetForTreeNode(node("group-views"))?.filter).toBe("views");
    expect(objectNavigatorTargetForTreeNode(node("group-procedures"))?.filter).toBe("procedures");
  });

  it.each(["oracle", "oceanbase-oracle", "dameng"] as const)("preserves the configured database for %s schema navigation", (db_type) => {
    const target = node("schema", { database: "APP_OWNER", schema: "APP_OWNER" });
    expect(objectNavigatorTargetForTreeNode(target, { db_type, database: "SYS" })).toMatchObject({ database: "SYS", schema: "APP_OWNER" });
    expect(objectNavigatorTargetForTreeNode(target, { db_type, database: "" })).toMatchObject({ database: "APP_OWNER", schema: "APP_OWNER" });
  });

  it.each(["postgres", "mysql"] as const)("preserves the selected database for %s schema navigation", (db_type) => {
    expect(objectNavigatorTargetForTreeNode(node("schema", { schema: "public" }), { db_type, database: "configured" })).toMatchObject({ database: "app", schema: "public" });
  });

  it("locates a selected table and ignores unrelated tree controls", () => {
    expect(objectNavigatorTargetForTreeNode(node("table", { label: "orders" }))).toMatchObject({ filter: "tables", selectedObjectName: "orders" });
    expect(objectNavigatorTargetForTreeNode(node("load-more"))).toBeNull();
  });
});
