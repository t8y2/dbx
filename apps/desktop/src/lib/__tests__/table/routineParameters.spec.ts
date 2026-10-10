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

const ORACLE_PACKAGE_MEMBER_SQL = `SELECT
  a.ARGUMENT_NAME AS "name",
  a.DATA_TYPE AS "data_type",
  a.IN_OUT AS "mode",
  a.POSITION AS "ordinal",
  a.DEFAULTED AS "has_default"
FROM ALL_ARGUMENTS a
JOIN ALL_PROCEDURES p
  ON p.OWNER = a.OWNER
 AND p.OBJECT_NAME = a.PACKAGE_NAME
 AND p.SUBPROGRAM_ID = a.SUBPROGRAM_ID
WHERE a.OWNER = UPPER('DBX_DEBUG')
  AND a.PACKAGE_NAME = UPPER('DBX_PL_DEBUG_PACKAGE')
  AND p.PROCEDURE_NAME = UPPER('DBX_SET_VALUE')
  AND a.POSITION > 0
ORDER BY a.SEQUENCE;`;

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
  it("resolves package members through ALL_PROCEDURES by SUBPROGRAM_ID, not through ALL_ARGUMENTS.PROCEDURE_NAME", () => {
    const sql = routineParametersQuery({
      databaseType: "oracle",
      schema: "DBX_DEBUG",
      routineName: "DBX_SET_VALUE",
      packageName: "DBX_PL_DEBUG_PACKAGE",
    });

    expect(sql).toBe(ORACLE_PACKAGE_MEMBER_SQL);
    expect(sql).toContain("ALL_PROCEDURES");
    expect(sql).toContain("SUBPROGRAM_ID");
    // The only PROCEDURE_NAME reference left is ALL_PROCEDURES.PROCEDURE_NAME
    // (aliased "p"); Oracle 19c ALL_ARGUMENTS has no such column (ORA-00904).
    expect(sql).toContain("AND p.PROCEDURE_NAME = UPPER(");
    expect(sql).not.toContain("AND PROCEDURE_NAME = UPPER(");
    expect(sql).not.toContain("FROM ALL_ARGUMENTS\nWHERE");
  });

  it("keeps the standalone Oracle shape unchanged (no PROCEDURE_NAME, no join)", () => {
    expect(
      routineParametersQuery({
        databaseType: "oracle",
        schema: "DBX_DEBUG",
        routineName: "DBX_PROBE",
      }),
    ).toBe(ORACLE_STANDALONE_SQL);
  });

  it("does not fall back to the legacy unqualified PACKAGE_NAME/PROCEDURE_NAME predicates", () => {
    const sql = routineParametersQuery({
      databaseType: "oracle",
      schema: "DBX_DEBUG",
      routineName: "DBX_SET_VALUE",
      packageName: "DBX_PL_DEBUG_PACKAGE",
    });

    expect(sql).not.toContain("\n  AND PACKAGE_NAME = UPPER(");
    expect(sql).not.toContain("\n  AND PROCEDURE_NAME = UPPER(");
  });
});

describe("OceanBase-Oracle and Dameng routine parameter SQL (unchanged)", () => {
  it.each(["oceanbase-oracle", "dameng"] as const)("keeps the package-member shape for %s", (databaseType) => {
    const sql = routineParametersQuery({
      databaseType,
      schema: "DBX_DEBUG",
      routineName: "DBX_SET_VALUE",
      packageName: "DBX_PL_DEBUG_PACKAGE",
    });

    expect(sql).toContain("FROM ALL_ARGUMENTS\nWHERE OWNER = UPPER('DBX_DEBUG')");
    expect(sql).toContain("  AND PACKAGE_NAME = UPPER('DBX_PL_DEBUG_PACKAGE')\n  AND PROCEDURE_NAME = UPPER('DBX_SET_VALUE')");
    expect(sql).not.toContain("ALL_PROCEDURES");
  });

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

describe("Oracle package member loading", () => {
  beforeEach(() => {
    apiMocks.executeQuery.mockReset();
    apiMocks.getObjectSource.mockReset();
  });

  it("runs the ALL_PROCEDURES join and maps the live DBX_PL_DEBUG_PACKAGE.DBX_SET_VALUE rows", async () => {
    apiMocks.executeQuery.mockResolvedValue(
      queryResult(
        ["name", "data_type", "mode", "ordinal", "has_default"],
        [
          ["FRAME#", "BINARY_INTEGER", "IN", "1", "N"],
          ["ASSIGNMENT_STATEMENT", "VARCHAR2", "IN", "2", "N"],
          ["RESULT", "BINARY_INTEGER", "OUT", "3", "N"],
          ["MESSAGE", "VARCHAR2", "OUT", "4", "N"],
        ],
      ),
    );

    await expect(
      loadRoutineParameters({
        connectionId: "connection-1",
        database: "dbatest",
        databaseType: "oracle",
        schema: "DBX_DEBUG",
        routineName: "DBX_SET_VALUE",
        packageName: "DBX_PL_DEBUG_PACKAGE",
      }),
    ).resolves.toEqual([
      { name: "FRAME#", dataType: "BINARY_INTEGER", mode: "IN", ordinal: 1, hasDefault: false },
      { name: "ASSIGNMENT_STATEMENT", dataType: "VARCHAR2", mode: "IN", ordinal: 2, hasDefault: false },
      { name: "RESULT", dataType: "BINARY_INTEGER", mode: "OUT", ordinal: 3, hasDefault: false },
      { name: "MESSAGE", dataType: "VARCHAR2", mode: "OUT", ordinal: 4, hasDefault: false },
    ]);

    expect(apiMocks.executeQuery).toHaveBeenCalledWith("connection-1", "dbatest", ORACLE_PACKAGE_MEMBER_SQL, "DBX_DEBUG", undefined, {
      maxRows: 200,
      pageSize: 200,
    });
  });
});
