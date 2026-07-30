import { describe, expect, it } from "vitest";
import { simpleDataGridOrderByColumn, simpleDataGridOrderByMatchesSort, simpleDataGridOrderByReferencesMissingColumn } from "@/lib/dataGrid/dataGridSort";

describe("simpleDataGridOrderByColumn", () => {
  it.each([
    ['"old_name" ASC', "old_name"],
    ["`old_name` DESC", "old_name"],
    ["[old_name] ASC", "old_name"],
    ["old_name DESC", "old_name"],
    ['n."old_name" ASC', "old_name"],
    ['"quoted""name" ASC', 'quoted"name'],
  ])("extracts a generated single-column order from %s", (orderBy, expected) => {
    expect(simpleDataGridOrderByColumn(orderBy)).toBe(expected);
  });

  it.each(["LOWER(name) ASC", "users.name ASC", '"name" ASC, "id" DESC', "name"])("leaves complex or incomplete orders untouched: %s", (orderBy) => {
    expect(simpleDataGridOrderByColumn(orderBy)).toBeUndefined();
  });
});

describe("simpleDataGridOrderByReferencesMissingColumn", () => {
  it("detects a generated order for a renamed column", () => {
    expect(simpleDataGridOrderByReferencesMissingColumn('"old_name" ASC', ["id", "new_name"])).toBe(true);
  });

  it("treats quoted identifier case as significant", () => {
    expect(simpleDataGridOrderByReferencesMissingColumn('"NEW_NAME" DESC', ["id", "new_name"])).toBe(true);
  });

  it("accepts an existing unquoted column case-insensitively", () => {
    expect(simpleDataGridOrderByReferencesMissingColumn("NEW_NAME DESC", ["id", "new_name"])).toBe(false);
  });

  it("does not reject a complex manual expression", () => {
    expect(simpleDataGridOrderByReferencesMissingColumn("LOWER(old_name) ASC", ["id", "new_name"])).toBe(false);
  });
});

describe("simpleDataGridOrderByMatchesSort", () => {
  it("recognizes the generated order owned by a structured sort", () => {
    expect(simpleDataGridOrderByMatchesSort('"created_at" DESC', "created_at", "desc")).toBe(true);
  });

  it("does not treat a manual order as owned by a stale structured sort", () => {
    expect(simpleDataGridOrderByMatchesSort("LOWER(name) ASC", "old_name", "asc")).toBe(false);
    expect(simpleDataGridOrderByMatchesSort('"name" ASC', "old_name", "asc")).toBe(false);
  });
});
