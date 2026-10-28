import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  executeQuery: vi.fn(),
  getObjectSource: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => apiMocks);

import { loadRoutineParameters, routineParametersQuery } from "@/lib/table/routineParameters";
import type { QueryResult } from "@/types/database";

function queryResult(columns: string[], rows: unknown[][]): QueryResult {
  return { columns, rows, affected_rows: 0, execution_time_ms: 0 };
}

const ORACLE_STANDALONE_SQL = `SELECT
  ARGUMENT_NAME AS "name",
  DATA_TYPE AS "data_type",
  IN_OUT AS "mode",
  POSITION AS "ordinal",
  DEFAULTED AS "has_default"
FROM ALL_ARGUMENTS
WHERE OWNER = UPPER('DBX_DEBUG')
  AND OBJECT_NAME = UPPER('DBX_PROBE')
  AND POSITION > 0
ORDER BY SEQUENCE;`;

describe("Oracle routine parameter SQL", () => {
  it("keeps the standalone Oracle shape unchanged (no PROCEDURE_NAME, no join)", () => {
    expect(
      routineParametersQuery({
        databaseType: "oracle",
        schema: "DBX_DEBUG",
        routineName: "DBX_PROBE",
      }),
    ).toBe(ORACLE_STANDALONE_SQL);
  });
});

describe("OceanBase-Oracle and Dameng routine parameter SQL (unchanged)", () => {
  it.each(["oceanbase-oracle", "dameng"] as const)("keeps the standalone shape for %s", (databaseType) => {
    expect(
      routineParametersQuery({
        databaseType,
        schema: "DBX_DEBUG",
        routineName: "DBX_PROBE",
      }),
    ).toBe(ORACLE_STANDALONE_SQL);
  });
});

describe("Oracle standalone routine loading", () => {
  beforeEach(() => {
    apiMocks.executeQuery.mockReset();
    apiMocks.getObjectSource.mockReset();
  });

  it("loads standalone metadata and maps parameter modes, ordinals and defaults", async () => {
    apiMocks.executeQuery.mockResolvedValue(
      queryResult(
        ["name", "data_type", "mode", "ordinal", "has_default"],
        [
          ["INPUT_COUNT", "BINARY_INTEGER", "IN", "1", "N"],
          ["LABEL", "VARCHAR2", "IN", "2", "Y"],
          ["TOTAL", "BINARY_INTEGER", "IN/OUT", "3", "N"],
          ["DETAIL", "VARCHAR2", "OUT", "4", "N"],
        ],
      ),
    );

    await expect(
      loadRoutineParameters({
        connectionId: "connection-1",
        database: "dbatest",
        databaseType: "oracle",
        schema: "DBX_DEBUG",
        routineName: "DBX_PROBE",
      }),
    ).resolves.toEqual([
      { name: "INPUT_COUNT", dataType: "BINARY_INTEGER", mode: "IN", ordinal: 1, hasDefault: false },
      { name: "LABEL", dataType: "VARCHAR2", mode: "IN", ordinal: 2, hasDefault: true },
      { name: "TOTAL", dataType: "BINARY_INTEGER", mode: "INOUT", ordinal: 3, hasDefault: false },
      { name: "DETAIL", dataType: "VARCHAR2", mode: "OUT", ordinal: 4, hasDefault: false },
    ]);

    expect(apiMocks.executeQuery).toHaveBeenCalledWith("connection-1", "dbatest", ORACLE_STANDALONE_SQL, "DBX_DEBUG", undefined, {
      maxRows: 200,
      pageSize: 200,
    });
  });
});
