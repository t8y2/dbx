import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/types/database";
import { buildPluginTableContext, buildPluginTableContextMenuInvocation } from "./pluginContext";

function tableNode(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    id: "connection:demo:public:users",
    label: "users",
    type: "table",
    connectionId: "conn-1",
    database: "demo",
    schema: "public",
    tableName: "users",
    ...overrides,
  };
}

describe("plugin table context", () => {
  it("builds the public context from canonical table metadata", () => {
    expect(buildPluginTableContext(tableNode())).toEqual({
      connectionId: "conn-1",
      database: "demo",
      schema: "public",
      table: "users",
    });
  });

  it("omits optional database and schema values when the node has no scope", () => {
    expect(buildPluginTableContext(tableNode({ database: undefined, schema: undefined }))).toEqual({
      connectionId: "conn-1",
      table: "users",
    });
    expect(buildPluginTableContext(tableNode({ database: "", schema: "" }))).toEqual({
      connectionId: "conn-1",
      table: "users",
    });
  });

  it("fails closed when canonical table identity is missing instead of using the label", () => {
    const node = tableNode({ tableName: undefined, label: "users" });

    expect(buildPluginTableContext(node)).toBeNull();
    expect(buildPluginTableContextMenuInvocation("example.inspect", node)).toBeNull();
  });

  it("prepares the existing contextMenu backend invocation without secrets", () => {
    expect(buildPluginTableContextMenuInvocation("example.inspect", tableNode())).toEqual({
      method: "contextMenu/example.inspect",
      params: {
        table: {
          connectionId: "conn-1",
          database: "demo",
          schema: "public",
          table: "users",
        },
      },
    });
  });

  it("does not build table context for non-table nodes", () => {
    expect(buildPluginTableContext(tableNode({ type: "view" }))).toBeNull();
  });
});
