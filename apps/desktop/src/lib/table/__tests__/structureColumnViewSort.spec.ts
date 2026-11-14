import { describe, expect, it } from "vitest";
import { sortStructureColumnRows, type StructureColumnSortRow, type StructureColumnSortValue } from "@/lib/table/structureColumnViewSort";

interface Column {
  name: string;
  type?: string;
  nullable?: boolean;
  primaryKey?: boolean;
  markedForDrop?: boolean;
}

function rows(columns: Column[]): StructureColumnSortRow<Column>[] {
  return columns.map((column, ordinal) => ({ column, ordinal }));
}

function valueOf(column: Column, key: string): StructureColumnSortValue {
  if (key === "nullable") return column.nullable;
  if (key === "primaryKey") return column.primaryKey;
  if (key === "type") return column.type ?? "";
  return column.name;
}

const names = (result: StructureColumnSortRow<Column>[]) => result.map((row) => row.column.name);
const ordinals = (result: StructureColumnSortRow<Column>[]) => result.map((row) => row.ordinal);

describe("sortStructureColumnRows", () => {
  const input = rows([{ name: "created_at" }, { name: "id" }, { name: "Name" }, { name: "col10" }, { name: "col2" }]);

  it("sorts ascending and descending by the requested key", () => {
    expect(names(sortStructureColumnRows(input, { key: "name", direction: "asc" }, valueOf))).toEqual(["col2", "col10", "created_at", "id", "Name"]);
    expect(names(sortStructureColumnRows(input, { key: "name", direction: "desc" }, valueOf))).toEqual(["Name", "id", "created_at", "col10", "col2"]);
  });

  it("uses numeric-aware, case-insensitive comparison", () => {
    // "col2" precedes "col10"; "Name" and "name" compare equal (case-insensitive).
    const numeric = rows([{ name: "col10" }, { name: "col2" }]);
    expect(names(sortStructureColumnRows(numeric, { key: "name", direction: "asc" }, valueOf))).toEqual(["col2", "col10"]);
    const cased = rows([{ name: "name" }, { name: "Name" }]);
    expect(names(sortStructureColumnRows(cased, { key: "name", direction: "asc" }, valueOf))).toEqual(["name", "Name"]);
  });

  it("is stable: equal keys keep their original relative order", () => {
    const equal = rows([
      { name: "same", type: "b" },
      { name: "same", type: "a" },
    ]);
    expect(ordinals(sortStructureColumnRows(equal, { key: "name", direction: "asc" }, valueOf))).toEqual([0, 1]);
    expect(ordinals(sortStructureColumnRows(equal, { key: "name", direction: "desc" }, valueOf))).toEqual([0, 1]);
  });

  it("keeps blank values last in both directions", () => {
    const blank = rows([{ name: "" }, { name: "b" }, { name: "a" }, { name: "  " }]);
    expect(names(sortStructureColumnRows(blank, { key: "name", direction: "asc" }, valueOf))).toEqual(["a", "b", "", "  "]);
    expect(names(sortStructureColumnRows(blank, { key: "name", direction: "desc" }, valueOf))).toEqual(["b", "a", "", "  "]);
  });

  it("orders booleans false before true and reverses with direction", () => {
    const bool = rows([{ name: "a", primaryKey: true }, { name: "b", primaryKey: false }, { name: "c" }]);
    expect(names(sortStructureColumnRows(bool, { key: "primaryKey", direction: "asc" }, valueOf))).toEqual(["b", "a", "c"]);
    expect(names(sortStructureColumnRows(bool, { key: "primaryKey", direction: "desc" }, valueOf))).toEqual(["a", "b", "c"]);
  });

  it("does not pin primary keys or drop-marked rows", () => {
    const mixed = rows([{ name: "z", primaryKey: true }, { name: "a", markedForDrop: true }, { name: "m" }]);
    expect(names(sortStructureColumnRows(mixed, { key: "name", direction: "asc" }, valueOf))).toEqual(["a", "m", "z"]);
  });

  it("preserves original ordinals so the # column still shows table order", () => {
    const result = sortStructureColumnRows(input, { key: "name", direction: "asc" }, valueOf);
    expect(ordinals(result)).toEqual([4, 3, 0, 1, 2]);
    expect(new Set(ordinals(result)).size).toBe(input.length);
  });

  it("does not mutate the input rows", () => {
    const snapshot = input.map((row) => ({ ...row }));
    sortStructureColumnRows(input, { key: "name", direction: "desc" }, valueOf);
    expect(input).toEqual(snapshot);
  });
});
