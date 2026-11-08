import { describe, expect, it } from "vitest";
import { matchSidebarLabel } from "@/lib/sidebar/sidebarSearch";
import { filterSidebarTree } from "@/lib/sidebar/sidebarSearchTree";
import type { TreeNode } from "@/types/database";

const exact = { matchMode: "exact" as const };
const table = (id: string, label: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, label, type: "table", ...extra });
describe("exact object-name search (#13845)", () => {
  it("matches the whole name case-insensitively, not partitions or fuzzy abbreviations", () => {
    expect(matchSidebarLabel("Orders", "orders", exact)?.kind).toBe("exact");
    for (const name of ["orders_2025", "old_orders", "order_details", "o_r_d_e_r_s"]) expect(matchSidebarLabel(name, "orders", exact)).toBeNull();
    expect(matchSidebarLabel("orders_2025", "orders")).not.toBeNull();
  });
  it("treats regex punctuation literally unless regex mode is enabled", () => {
    expect(matchSidebarLabel("orders", "/orders/", exact)).toBeNull();
    expect(matchSidebarLabel("/orders/", "/orders/", exact)).not.toBeNull();
    expect(matchSidebarLabel("orders_2025", "^orders", { ...exact, regexMode: true })).not.toBeNull();
    expect(matchSidebarLabel("orders", "", exact)).toBeNull();
  });
  it("does not match comments or aliases but preserves the matching object's ancestor path", () => {
    const children = [table("orders", "orders"), table("partition", "orders_2025"), table("comment", "customers", { comment: "orders" }), table("alias", "invoices", { searchAliases: ["orders"] })];
    const nodes: TreeNode[] = [{ id: "conn", type: "connection", label: "local", children: [{ id: "db", type: "database", label: "main", children }] }];
    const result = filterSidebarTree(nodes, "orders", new Set(), undefined, exact);
    expect(result[0].children?.[0].children?.map((n) => n.id)).toEqual(["orders"]);
  });
  it("does not turn an exact database hit into all tables matching", () => {
    const nodes: TreeNode[] = [{ id: "db", type: "database", label: "orders", children: [table("other", "customers"), table("hit", "orders")] }];
    expect(filterSidebarTree(nodes, "orders", new Set(), undefined, exact)[0].children?.map((n) => n.id)).toEqual(["hit"]);
  });
  it("keeps table details expandable and leaves empty-query browsing unchanged", () => {
    const nodes = [table("orders", "orders", { children: [{ id: "columns", type: "group-columns", label: "Columns" }] })];
    expect(filterSidebarTree(nodes, "orders", new Set(), undefined, exact)[0].children?.[0].id).toBe("columns");
    expect(filterSidebarTree(nodes, "", new Set(), undefined, exact)).toBe(nodes);
  });
});
