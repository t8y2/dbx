import { describe, expect, it } from "vitest";
import type { DatabaseExportSelectedObject } from "@/lib/backend/api";
import { buildSelectedTablesPayload, databaseExportSelectedObjectsRequest, isDatabaseExportTableSelectionValid, splitDatabaseExportObjectSelection } from "@/lib/export/databaseExportSelection";

const picked = (objectType: string, name: string, signature?: string): DatabaseExportSelectedObject => ({ objectType, name, ...(signature === undefined ? {} : { signature }) });

describe("splitDatabaseExportObjectSelection (#13940)", () => {
  const allTables = ["orders", "T_CUSTOMER", "V_CUSTOMER"];

  it.each([
    ["keeps listed tables and views in list order", [picked("VIEW", "V_CUSTOMER"), picked("TABLE", "orders")], { tables: ["orders", "V_CUSTOMER"], others: [] }],
    ["keeps a routine named like a table out of the table list", [picked("FUNCTION", "orders", "integer")], { tables: [], others: [picked("FUNCTION", "orders", "integer")] }],
    ["keeps objects the list cannot show", [picked("TABLE", "orders"), picked("SEQUENCE", "SEQ_ORDER"), picked("VIEW", "V_UNLISTED")], { tables: ["orders"], others: [picked("SEQUENCE", "SEQ_ORDER"), picked("VIEW", "V_UNLISTED")] }],
  ])("%s", (_name, objects, expected) => {
    expect(splitDatabaseExportObjectSelection(objects, allTables)).toEqual(expected);
  });
});

describe("databaseExportSelectedObjectsRequest (#13940)", () => {
  const viewNames = new Set(["V_CUSTOMER"]);

  it.each([
    ["sends the checked tables and views with their types", ["orders", "V_CUSTOMER"], [], [picked("TABLE", "orders"), picked("VIEW", "V_CUSTOMER")]],
    ["keeps a routine named like a table typed as a routine", [], [picked("FUNCTION", "orders", "integer")], [picked("FUNCTION", "orders", "integer")]],
    ["sends an empty list once every table is unchecked", [], [], []],
  ])("%s", (_name, selectedTables, others, expected) => {
    expect(databaseExportSelectedObjectsRequest(selectedTables, viewNames, others)).toEqual(expected);
  });
});

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
