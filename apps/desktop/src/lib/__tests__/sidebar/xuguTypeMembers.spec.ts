import { describe, expect, it } from "vitest";
import { buildXuguTypeMemberNodes, isXuguTypeMemberContainer, markXuguTypeNodesExpandable } from "@/lib/sidebar/xuguTypeMembers";
import type { TreeNode } from "@/types/database";

const typeNode: TreeNode = {
  id: "connection:database:schema:type:OrderType",
  label: "OrderType",
  objectName: "OrderType",
  type: "type",
  connectionId: "connection",
  database: "database",
  schema: "AppSchema",
  isExpanded: false,
};

describe("Xugu object type members", () => {
  it("keeps the member loader exclusive to Xugu type specifications", () => {
    expect(isXuguTypeMemberContainer(typeNode, "xugu")).toBe(true);
    expect(isXuguTypeMemberContainer(typeNode, "oracle")).toBe(false);
    expect(isXuguTypeMemberContainer({ ...typeNode, type: "type-body" }, "xugu")).toBe(false);
    expect(isXuguTypeMemberContainer({ ...typeNode, database: undefined }, "xugu")).toBe(false);
  });

  it("makes only type specification nodes explicit containers", () => {
    const nodes = markXuguTypeNodesExpandable([
      typeNode,
      { ...typeNode, id: "body", type: "type-body" },
      { ...typeNode, id: "function", type: "function" },
    ]);

    expect(nodes[0]?.children).toEqual([]);
    expect(nodes[0]?.xuguTypeMembersExpandable).toBe(true);
    expect(nodes[1]?.children).toBeUndefined();
    expect(nodes[1]?.xuguTypeMembersExpandable).toBeUndefined();
    expect(nodes[2]?.children).toBeUndefined();
  });

  it("renders attributes and callable members without treating them as top-level routines", () => {
    const nodes = buildXuguTypeMemberNodes(typeNode, [
      { name: "itemId", kind: "column", data_type: "INTEGER" },
      { name: "total", kind: "function", signature: "quantity INTEGER, price NUMERIC(12,2)", data_type: "NUMERIC(18,2)" },
      { name: "rename", kind: "procedure", signature: "OUT result VARCHAR(40)" },
      { name: "itemId", kind: "column", data_type: "INTEGER" },
    ]);

    expect(nodes.map((node) => ({ type: node.type, label: node.label }))).toEqual([
      { type: "type-attribute", label: "itemId (INTEGER)" },
      { type: "type-method", label: "FUNCTION total(quantity INTEGER, price NUMERIC(12,2)) → NUMERIC(18,2)" },
      { type: "type-method", label: "PROCEDURE rename(OUT result VARCHAR(40))" },
    ]);
    expect(nodes.every((node) => node.parentType === "type" && node.parentName === "OrderType" && node.children === undefined)).toBe(true);
  });
});
