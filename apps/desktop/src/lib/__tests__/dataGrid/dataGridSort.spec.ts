import { describe, expect, it } from "vitest";
import { compareDataGridValues, simpleDataGridOrderByColumn, simpleDataGridOrderByMatchesSort, simpleDataGridOrderByReferencesMissingColumn } from "@/lib/dataGrid/dataGridSort";

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

describe("compareDataGridValues datetime ordering", () => {
  it("orders space-separated timestamps with microsecond precision", () => {
    expect(compareDataGridValues("2024-01-01 12:00:00.123456", "2024-01-01 12:00:00.500000")).toBeLessThan(0);
    expect(compareDataGridValues("2024-01-01 12:00:00.500000", "2024-01-01 12:00:00.123456")).toBeGreaterThan(0);
  });

  it("orders dates before earlier-day late times across midnight", () => {
    expect(compareDataGridValues("2024-01-02 00:00:00", "2024-01-01 23:59:59")).toBeGreaterThan(0);
  });

  it("normalizes numeric UTC offsets so equal instants compare equal", () => {
    expect(compareDataGridValues("2024-01-01 12:00:00+08", "2024-01-01 13:00:00+09")).toBe(0);
    expect(compareDataGridValues("2024-01-01 11:00:00+09", "2024-01-01 12:00:00+08")).toBeLessThan(0);
  });

  it("sorts PostgreSQL infinity sentinels beyond finite timestamps", () => {
    expect(compareDataGridValues("infinity", "9999-12-31 23:59:59")).toBeGreaterThan(0);
    expect(compareDataGridValues("-infinity", "0001-01-01 00:00:00")).toBeLessThan(0);
  });

  it("still parses ISO-T timestamps with Zulu suffix", () => {
    expect(compareDataGridValues("2024-01-01T12:00:00Z", "2024-01-01T12:00:01Z")).toBeLessThan(0);
  });

  it("falls back to collation for non-datetime strings", () => {
    expect(compareDataGridValues("zebra", "apple")).toBeGreaterThan(0);
  });

  it("keeps null values after populated datetime cells", () => {
    expect(compareDataGridValues(null, "2024-01-01 00:00:00")).toBeGreaterThan(0);
  });
});
