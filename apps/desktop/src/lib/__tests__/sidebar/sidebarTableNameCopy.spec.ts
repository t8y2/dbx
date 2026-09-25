import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/types/database";
import { columnNameForSidebarDrag, formatSidebarTableNamesForCopy, normalizeSidebarCopyTableNameSeparator, resolveSidebarColumnDragNames, resolveSidebarColumnDragTargets, resolveSidebarTableCopyTargets } from "@/lib/sidebar/sidebarTableNameCopy";

describe("sidebarTableNameCopy", () => {
  const table = (id: string, label: string, schema = "public"): TreeNode => ({
    id,
    label,
    type: "table",
    connectionId: "c1",
    database: "db",
    schema,
  });

  const column = (id: string, label: string, name: string): TreeNode => ({
    id,
    label,
    type: "column",
    connectionId: "c1",
    database: "db",
    schema: "public",
    tableName: "users",
    meta: { name },
  });

  it("resolves multi-table copy targets in visible order", () => {
    const first = table("t1", "one");
    const second = table("t2", "two");
    const third = table("t3", "three");
    expect(resolveSidebarTableCopyTargets(first, [third, first, second])).toEqual([third, first, second]);
    expect(resolveSidebarTableCopyTargets(first, [second])).toEqual([first]);
  });

  it("falls back to active node when selection is mixed connection", () => {
    const first = table("t1", "one");
    const other = { ...table("t2", "two"), connectionId: "c2" };
    expect(resolveSidebarTableCopyTargets(first, [first, other])).toEqual([first]);
  });

  it("formats bare and qualified table names", () => {
    const targets = [table("t1", "users"), table("t2", "orders", "sales")];
    expect(formatSidebarTableNamesForCopy(targets, { separator: "comma", includeSchema: false })).toBe("users,orders");
    expect(formatSidebarTableNamesForCopy(targets, { separator: "newline", includeSchema: true, databaseType: "postgres" })).toBe('"public"."users"\n"sales"."orders"');
    expect(formatSidebarTableNamesForCopy([table("t1", "users")], { separator: "comma", includeSchema: true, databaseType: "mysql" })).toBe("`users`");
    expect(formatSidebarTableNamesForCopy([table("t1", "users", "default")], { separator: "comma", includeSchema: true, databaseType: "hive", schema: "default" })).toBe("`default`.`users`");
  });

  it("resolves multi-column drag targets for the same table", () => {
    const first = column("c1", "id (bigint)", "id");
    const second = column("c2", "name (text)", "name");
    expect(resolveSidebarColumnDragTargets(first, [second, first])).toEqual([second, first]);
    expect(resolveSidebarColumnDragNames(first, [second, first])).toEqual(["name", "id"]);
  });

  it("falls back to active column when selection spans tables", () => {
    const first = column("c1", "id (bigint)", "id");
    const other = { ...column("c2", "name (text)", "name"), tableName: "orders" };
    expect(resolveSidebarColumnDragTargets(first, [first, other])).toEqual([first]);
  });

  it("extracts column drag names from labels", () => {
    expect(columnNameForSidebarDrag(column("c1", "created_at (timestamp)", "created_at"))).toBe("created_at");
  });

  it("normalizes separator settings", () => {
    expect(normalizeSidebarCopyTableNameSeparator("comma-newline")).toBe("comma-newline");
    expect(normalizeSidebarCopyTableNameSeparator("bogus")).toBe("comma");
  });
});
