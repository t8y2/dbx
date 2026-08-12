import { describe, expect, it } from "vitest";
import { buildXuguTypeMemberNodes, isXuguTypeMemberContainer } from "@/lib/sidebar/xuguTypeMembers";
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
  xuguTypeMembersExpandable: true,
};

describe("Xugu object type members", () => {
  it("keeps the member loader exclusive to Xugu type specifications", () => {
    expect(isXuguTypeMemberContainer(typeNode, "xugu")).toBe(true);
    expect(isXuguTypeMemberContainer(typeNode, "oracle")).toBe(false);
    expect(isXuguTypeMemberContainer({ ...typeNode, type: "type-body" }, "xugu")).toBe(false);
    expect(isXuguTypeMemberContainer({ ...typeNode, xuguTypeMembersExpandable: false }, "xugu")).toBe(false);
    expect(isXuguTypeMemberContainer({ ...typeNode, database: undefined }, "xugu")).toBe(false);
  });

  it("renders attributes and callable members without treating them as top-level routines", () => {
    const nodes = buildXuguTypeMemberNodes(typeNode, [
      { name: "itemId", kind: "column", data_type: "INTEGER" },
      { name: "total", kind: "function", signature: "quantity INTEGER, price NUMERIC(12,2)", data_type: "NUMERIC(18,2)" },
      { name: "rename", kind: "procedure", signature: "OUT result VARCHAR(40)" },
      { name: "itemId", kind: "column", data_type: "INTEGER" },
    ]);

    expect(nodes.map((node) => ({ type: node.type, label: node.label, objectCount: node.objectCount }))).toEqual([
      { type: "type-attributes", label: "tree.attributes", objectCount: 1 },
      { type: "type-methods", label: "tree.methods", objectCount: 2 },
    ]);
    expect(nodes.every((node) => node.parentType === "type" && node.parentName === "OrderType")).toBe(true);
    expect(nodes[0].children?.map((node) => ({ type: node.type, label: node.label }))).toEqual([{ type: "type-attribute", label: "itemId (INTEGER)" }]);
    expect(nodes[1].children?.map((node) => ({ type: node.type, label: node.label }))).toEqual([
      { type: "type-method", label: "FUNCTION total(quantity INTEGER, price NUMERIC(12,2)) → NUMERIC(18,2)" },
      { type: "type-method", label: "PROCEDURE rename(OUT result VARCHAR(40))" },
    ]);
    expect(nodes.flatMap((node) => node.children ?? []).every((node) => node.parentType === "type" && node.parentName === "OrderType" && node.children === undefined)).toBe(true);
  });

  it("omits the methods group when a type only has attributes", () => {
    const nodes = buildXuguTypeMemberNodes(typeNode, [{ name: "itemId", kind: "column", data_type: "INTEGER" }]);

    expect(nodes.map((node) => ({ type: node.type, objectCount: node.objectCount }))).toEqual([{ type: "type-attributes", objectCount: 1 }]);
  });

  it("omits the attributes group when a type only has methods", () => {
    const nodes = buildXuguTypeMemberNodes(typeNode, [{ name: "rename", kind: "procedure", signature: "newName VARCHAR(40)" }]);

    expect(nodes.map((node) => ({ type: node.type, objectCount: node.objectCount }))).toEqual([{ type: "type-methods", objectCount: 1 }]);
  });

  it("returns no groups when a type has no members", () => {
    expect(buildXuguTypeMemberNodes(typeNode, [])).toEqual([]);
  });
});
