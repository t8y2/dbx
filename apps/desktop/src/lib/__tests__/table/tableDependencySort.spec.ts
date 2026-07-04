import { describe, expect, it } from "vitest";
import { sortTablesByFkDependency, type TableWithFk } from "@/lib/table/tableDependencySort";

function fk(refTable: string) {
  return { name: `fk_to_${refTable}`, column: "id", ref_table: refTable, ref_column: "id" };
}

function table(name: string, foreignKeys: ReturnType<typeof fk>[] = []): TableWithFk {
  return { name, foreignKeys };
}

describe("sortTablesByFkDependency", () => {
  it("returns single table unchanged", () => {
    const input = [table("t1")];
    const result = sortTablesByFkDependency(input);
    expect(result.map((t) => t.name)).toEqual(["t1"]);
  });

  it("returns empty array unchanged", () => {
    expect(sortTablesByFkDependency([])).toEqual([]);
  });

  it("preserves original order when no FK dependencies exist", () => {
    const input = [table("t2"), table("t1")];
    const result = sortTablesByFkDependency(input);
    expect(result.map((t) => t.name)).toEqual(["t2", "t1"]);
  });

  it("sorts referencing table before referenced table (simple dependency)", () => {
    // t2 references t1 → t2 should be dropped before t1
    const input = [table("t1"), table("t2", [fk("t1")])];
    const result = sortTablesByFkDependency(input);
    expect(result.map((t) => t.name)).toEqual(["t2", "t1"]);
  });

  it("sorts referencing table before referenced table regardless of input order", () => {
    // Input order reversed from the above test
    const input = [table("t2", [fk("t1")]), table("t1")];
    const result = sortTablesByFkDependency(input);
    expect(result.map((t) => t.name)).toEqual(["t2", "t1"]);
  });

  it("handles chain dependency (C→B→A)", () => {
    // t3 references t2, t2 references t1 → t3, t2, t1
    const input = [table("t1"), table("t2", [fk("t1")]), table("t3", [fk("t2")])];
    const result = sortTablesByFkDependency(input);
    expect(result.map((t) => t.name)).toEqual(["t3", "t2", "t1"]);
  });

  it("handles multiple tables referencing the same table", () => {
    // t2 and t3 both reference t1 → t2,t3 before t1
    const input = [table("t1"), table("t2", [fk("t1")]), table("t3", [fk("t1")])];
    const result = sortTablesByFkDependency(input);
    const names = result.map((t) => t.name);
    // t1 must be last
    expect(names[names.length - 1]).toBe("t1");
    // t2 and t3 must come before t1
    expect(names.slice(0, 2)).toEqual(expect.arrayContaining(["t2", "t3"]));
  });

  it("falls back to original order on cyclic dependency", () => {
    // t1 references t2 and t2 references t1
    const input = [table("t1", [fk("t2")]), table("t2", [fk("t1")])];
    const result = sortTablesByFkDependency(input);
    expect(result.map((t) => t.name)).toEqual(["t1", "t2"]);
  });

  it("ignores FK references to tables not in the selected set", () => {
    // t2 references t3 (not selected), t1 has no FK → original order
    const input = [table("t1"), table("t2", [fk("t3")])];
    const result = sortTablesByFkDependency(input);
    expect(result.map((t) => t.name)).toEqual(["t1", "t2"]);
  });

  it("handles table with multiple FKs where only some target selected tables", () => {
    // t3 references both t1 (selected) and t4 (not selected)
    const input = [table("t1"), table("t3", [fk("t1"), fk("t4")])];
    const result = sortTablesByFkDependency(input);
    expect(result.map((t) => t.name)).toEqual(["t3", "t1"]);
  });

  it("handles complex DAG with multiple branches", () => {
    // t4 → t2 → t1
    // t3 → t1
    const input = [table("t1"), table("t2", [fk("t1")]), table("t3", [fk("t1")]), table("t4", [fk("t2")])];
    const result = sortTablesByFkDependency(input);
    const names = result.map((t) => t.name);
    // t1 must be last (everything references it directly or indirectly)
    expect(names[names.length - 1]).toBe("t1");
    // t4 must come before t2
    expect(names.indexOf("t4")).toBeLessThan(names.indexOf("t2"));
    // t2 and t3 must come before t1
    expect(names.indexOf("t2")).toBeLessThan(names.indexOf("t1"));
    expect(names.indexOf("t3")).toBeLessThan(names.indexOf("t1"));
  });
});
