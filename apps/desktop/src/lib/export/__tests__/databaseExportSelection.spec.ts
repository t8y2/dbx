import { describe, expect, it } from "vitest";
import { buildSelectedTablesPayload, isDatabaseExportTableSelectionValid } from "@/lib/export/databaseExportSelection";

describe("buildSelectedTablesPayload", () => {
  it("returns undefined when all tables are selected without extra objects", () => {
    const allTables = ["users", "orders", "products"];
    const selectedTables = ["users", "orders", "products"];

    expect(buildSelectedTablesPayload(allTables, selectedTables)).toBeUndefined();
  });

  it("returns filtered tables when a subset of tables is selected", () => {
    const allTables = ["users", "orders", "products"];
    const selectedTables = ["orders"];

    expect(buildSelectedTablesPayload(allTables, selectedTables)).toEqual(["orders"]);
  });

  it("preserves non-table object names (views, sequences, routines) in the selection payload", () => {
    const allTables = ["users", "orders"];
    const selectedTables = ["orders", "v_active_users", "user_id_seq"];

    expect(buildSelectedTablesPayload(allTables, selectedTables)).toEqual(["orders", "v_active_users", "user_id_seq"]);
  });

  it("returns only non-table objects when no tables are selected", () => {
    const allTables = ["users", "orders"];
    const selectedTables = ["v_active_users", "user_id_seq"];

    expect(buildSelectedTablesPayload(allTables, selectedTables)).toEqual(["v_active_users", "user_id_seq"]);
  });

  it("returns empty array when selectedTables is empty", () => {
    const allTables = ["users", "orders"];
    const selectedTables: string[] = [];

    expect(buildSelectedTablesPayload(allTables, selectedTables)).toEqual([]);
  });
});

describe("isDatabaseExportTableSelectionValid", () => {
  it("is valid when neither structure nor data is selected", () => {
    expect(
      isDatabaseExportTableSelectionValid({
        allTableCount: 10,
        selectedTableCount: 0,
        includeStructure: false,
        includeData: false,
      }),
    ).toBe(true);
  });

  it("is valid when tables are present and at least one is selected", () => {
    expect(
      isDatabaseExportTableSelectionValid({
        allTableCount: 10,
        selectedTableCount: 1,
        includeStructure: true,
        includeData: true,
      }),
    ).toBe(true);
  });

  it("is invalid when tables exist but none are selected with structure or data enabled", () => {
    expect(
      isDatabaseExportTableSelectionValid({
        allTableCount: 10,
        selectedTableCount: 0,
        includeStructure: true,
        includeData: false,
      }),
    ).toBe(false);
  });
});
