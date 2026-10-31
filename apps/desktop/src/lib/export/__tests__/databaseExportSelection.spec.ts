import { describe, expect, it } from "vitest";
import { buildSelectedTablesPayload, databaseExportSelectedTablesRequest, isDatabaseExportTableSelectionValid } from "@/lib/export/databaseExportSelection";

describe("databaseExportSelectedTablesRequest", () => {
  const allTables = ["T_CUSTOMER", "T_ORDER", "V_CUSTOMER"];
  const objectsOnly = { includeStructure: false, includeData: false };

  it.each([
    ["sends picked routines when only objects are exported (#13940)", ["PRC_ADD_CUSTOMER", "PRC_CLEAR_ORDERS"], { ...objectsOnly, explicitObjectSelection: true }, ["PRC_ADD_CUSTOMER", "PRC_CLEAR_ORDERS"]],
    ["sends a picked view that is also in the table list", ["V_CUSTOMER"], { ...objectsOnly, explicitObjectSelection: true }, ["V_CUSTOMER"]],
    ["keeps table order before other objects", ["PKG_ORDER", "T_ORDER", "T_CUSTOMER"], { includeStructure: true, includeData: false, explicitObjectSelection: true }, ["T_CUSTOMER", "T_ORDER", "PKG_ORDER"]],
    ["does not collapse a picked selection that covers every table", allTables, { includeStructure: true, includeData: true, explicitObjectSelection: true }, allTables],
    ["leaves objects-only sidebar exports schema-wide", ["T_ORDER"], { ...objectsOnly, explicitObjectSelection: false }, undefined],
    ["keeps the all-tables shortcut for sidebar exports", allTables, { includeStructure: true, includeData: true, explicitObjectSelection: false }, undefined],
    ["sends a sidebar table subset when tables are exported", ["T_ORDER"], { includeStructure: true, includeData: false, explicitObjectSelection: false }, ["T_ORDER"]],
  ])("%s", (_name, selectedTables, options, expected) => {
    expect(databaseExportSelectedTablesRequest(allTables, selectedTables, options)).toEqual(expected);
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
