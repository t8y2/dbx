import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  executeQuery: vi.fn(),
  getObjectSource: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => apiMocks);

import { oraclePackageMemberEntries } from "@/lib/sql/oraclePackageMembers";
import { buildProcedureExecutionSqlFromValues } from "@/lib/table/routineExecutionSql";
import { loadOraclePackageProcedureParameters, loadRoutineParameters, routineParametersQuery } from "@/lib/table/routineParameters";
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

describe("Oracle package procedure execution", () => {
  const spec = `CREATE PACKAGE "Owner"."Pkg" AS
    PROCEDURE no_args;
    PROCEDURE "Run.It"("inValue" NUMBER DEFAULT 42, "outValue" OUT VARCHAR2);
  END;`;
  const body = `CREATE PACKAGE BODY "Owner"."Pkg" AS
    PROCEDURE "Run.It"("inValue" NUMBER, "outValue" OUT VARCHAR2) IS BEGIN NULL; END;
    PROCEDURE "Run.It"("inValue" VARCHAR2, "outValue" OUT VARCHAR2) IS BEGIN NULL; END;
  END;`;
  const [publicMember, privateOverload] = oraclePackageMemberEntries(body);
  const target = { connectionId: "connection-1", database: "dbatest", schema: "Owner", packageName: "Pkg", member: publicMember! };
  const columns = ["name", "data_type", "mode", "ordinal", "has_default", "signature_count"];

  beforeEach(() => {
    apiMocks.getObjectSource.mockReset().mockResolvedValue({ source: spec });
    apiMocks.executeQuery.mockReset();
  });

  it("loads the exact public member and generates a three-part call with defaults and output", async () => {
    apiMocks.executeQuery.mockResolvedValue(
      queryResult(columns, [
        ["inValue", "NUMBER", "IN", 1, "Y", 1],
        ["outValue", "VARCHAR2", "OUT", 2, "N", 1],
      ]),
    );
    const result = await loadOraclePackageProcedureParameters(target);
    expect(apiMocks.getObjectSource).toHaveBeenCalledWith("connection-1", "dbatest", "Owner", "Pkg", "PACKAGE");
    expect(apiMocks.executeQuery.mock.calls[0]?.[2]).toContain("p.PROCEDURE_NAME = 'Run.It'");
    expect(result).toHaveProperty("parameters");
    if (!("parameters" in result)) throw new Error("Expected public procedure parameters");
    const sql = buildProcedureExecutionSqlFromValues({
      databaseType: "oracle",
      schema: target.schema,
      packageName: target.packageName,
      routineName: target.member.databaseName,
      parameters: result.parameters.map((parameter) => ({ ...parameter, value: "", useDefault: parameter.hasDefault })),
    });
    expect(sql).toContain('"Owner"."Pkg"."Run.It"("outValue" => dbx_output_2);');
    expect(sql).toContain("DBMS_OUTPUT.PUT_LINE('outValue = '");
  });

  it.each([null, 0])("keeps no-argument procedures with dictionary position %s", async (position) => {
    apiMocks.executeQuery.mockResolvedValue(queryResult(columns, [[null, null, null, position, null, 1]]));
    await expect(loadOraclePackageProcedureParameters({ ...target, member: oraclePackageMemberEntries(spec)[0]! })).resolves.toEqual({ parameters: [] });
  });

  it("does not treat a private body overload as the public procedure with the same name", async () => {
    await expect(loadOraclePackageProcedureParameters({ ...target, member: privateOverload! })).resolves.toEqual({ unavailable: "notCallable" });
    expect(apiMocks.executeQuery).not.toHaveBeenCalled();
  });

  it("blocks ambiguous overloads even if the response contains rows for only the first signature", async () => {
    apiMocks.executeQuery.mockResolvedValue(
      queryResult(columns, [
        ["inValue", "NUMBER", "IN", 1, "Y", "2"],
        ["outValue", "VARCHAR2", "OUT", 2, "N", "2"],
      ]),
    );
    await expect(loadOraclePackageProcedureParameters(target)).resolves.toEqual({ unavailable: "overloaded" });
  });

  it("blocks a partial protocol result for a procedure with parameters", async () => {
    apiMocks.executeQuery.mockResolvedValue(queryResult(columns, [["inValue", "NUMBER", "IN", 1, "Y", 1]]));
    await expect(loadOraclePackageProcedureParameters(target)).resolves.toEqual({ unavailable: "notCallable" });
  });
});
