import { describe, expect, it } from "vitest";
import {
  buildOracleCompileSql,
  buildOracleInvalidObjectsPageSql,
  buildOracleInvalidObjectsSql,
  buildOracleObjectErrorsSql,
  buildOracleObjectIdentitySql,
  mapOracleInvalidObjects,
  mapOracleObjectErrors,
  oracleCompileUnsupportedReason,
  oracleInvalidObjectSourceKind,
  readAllOracleInvalidObjects,
  ORACLE_INVALID_OBJECTS_PAGE_SIZE,
} from "../oracleInvalidObjects";

describe("Oracle invalid-object SQL and mapping", () => {
  const pageColumns = ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID", "LAST_DDL_TIME"];
  it.each(["VIEW", "MATERIALIZED VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE", "SYNONYM", "PACKAGE", "PACKAGE BODY", "TYPE", "TYPE BODY"])("maps source-readable %s to its API kind", (type) => {
    expect(oracleInvalidObjectSourceKind(type)).toBe(type.replaceAll(" ", "_"));
  });

  it.each(["INDEX", "JAVA CLASS", "JAVA SOURCE", "TABLE", "", "__proto__"])("rejects unsupported source kind %s", (type) => {
    expect(oracleInvalidObjectSourceKind(type)).toBeNull();
  });

  it("builds an owner-quoted numeric keyset page with a string cursor", () => {
    const sql = buildOracleInvalidObjectsPageSql("Owner'X", "90071992547409931234");
    expect(sql).toContain("OWNER = 'Owner''X'");
    expect(sql).toContain("OBJECT_ID > 90071992547409931234");
    expect(sql).toContain("TO_CHAR(OBJECT_ID) AS OBJECT_ID");
    expect(sql).toContain("ORDER BY OBJECT_ID");
    expect(sql).toContain(`ROWNUM <= ${ORACLE_INVALID_OBJECTS_PAGE_SIZE}`);
    expect(() => buildOracleInvalidObjectsPageSql("APP", "1 OR 1=1")).toThrow("Invalid Oracle object ID cursor");
  });

  it.each([0, 500, 501, 5001])("reads every visible invalid object across keyset pages (%i rows)", async (count) => {
    const queries: Array<[string, number]> = [];
    const objects = Array.from({ length: count }, (_, index) => {
      const objectId = index === 0 ? "90071992547409931234" : String(90071992547409931234n + BigInt(index));
      return ["APP", `P_${index}`, "PROCEDURE", objectId, "2026-10-20 09:00:00"];
    });
    const rowsByCursor = (sql: string) => {
      const cursor = BigInt(sql.match(/OBJECT_ID > (\d+)/)?.[1] ?? "0");
      return objects.filter((row) => BigInt(row[3] as string) > cursor).slice(0, ORACLE_INVALID_OBJECTS_PAGE_SIZE);
    };
    const result = await readAllOracleInvalidObjects(async (sql, maxRows) => {
      queries.push([sql, maxRows]);
      return { columns: pageColumns, rows: rowsByCursor(sql) };
    }, "APP");
    expect(result).toHaveLength(count);
    expect(new Set(result.map((object) => object.objectId)).size).toBe(count);
    expect(queries.every(([, maxRows]) => maxRows === 501)).toBe(true);
    expect(queries.length).toBe(count === 0 ? 1 : Math.floor(count / ORACLE_INVALID_OBJECTS_PAGE_SIZE) + 1);
  });

  it.each([
    [
      "duplicate/non-advancing IDs",
      [
        ["APP", "A", "PROCEDURE", "2", "time"],
        ["APP", "B", "PROCEDURE", "2", "time"],
      ],
    ],
    ["missing fields", [["APP", "A", "PROCEDURE", "2"]]],
    ["wrong owner", [["OTHER", "A", "PROCEDURE", "2", "time"]]],
    ["numeric object IDs", [["APP", "A", "PROCEDURE", 2, "time"]]],
  ])("rejects %s instead of producing a partial plan", async (_label, rows) => {
    await expect(readAllOracleInvalidObjects(async () => ({ columns: pageColumns, rows }), "APP")).rejects.toThrow();
  });

  it("rejects truncated, overfull, execution-error, and middle-page failures", async () => {
    await expect(readAllOracleInvalidObjects(async () => ({ columns: pageColumns, rows: [], truncated: true }), "APP")).rejects.toThrow("truncated");
    await expect(readAllOracleInvalidObjects(async () => ({ columns: pageColumns, rows: Array.from({ length: 501 }, (_, index) => ["APP", `P${index}`, "PROCEDURE", String(index + 1), "time"]) }), "APP")).rejects.toThrow("truncated");
    await expect(readAllOracleInvalidObjects(async () => ({ columns: pageColumns, rows: [["ORA-01031"]], execution_error: true, error: { detail: "ORA-01031: denied" } }), "APP")).rejects.toThrow("ORA-01031: denied");

    let page = 0;
    await expect(
      readAllOracleInvalidObjects(async () => {
        page++;
        if (page === 2) throw new Error("middle page failed");
        return { columns: pageColumns, rows: Array.from({ length: 500 }, (_, index) => ["APP", `P${index}`, "PROCEDURE", String(index + 1), "time"]) };
      }, "APP"),
    ).rejects.toThrow("middle page failed");
  });

  it("rejects a page that omits required dictionary columns", async () => {
    await expect(readAllOracleInvalidObjects(async () => ({ columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID"], rows: [] }), "APP")).rejects.toThrow("omitted required columns");
  });

  it("quotes schema and names as SQL literals and limits the complete ordered listing", () => {
    const sql = buildOracleInvalidObjectsSql("Owner'X", 501);
    expect(sql).toContain("OWNER = 'Owner''X'");
    expect(sql).toContain("STATUS = 'INVALID'");
    expect(sql).toContain("ORDER BY OBJECT_NAME, OBJECT_TYPE");
    expect(sql).toContain("ROWNUM <= 501");
  });

  it("preserves distinct object/body types and creates exact identity/error queries", () => {
    const object = { owner: "A", name: 'p"name', type: "PACKAGE BODY", objectId: "52", lastDdlTime: "now" };
    const rows = mapOracleInvalidObjects(
      [
        ["A", object.name, "PACKAGE", 51, "now"],
        ["A", object.name, "PACKAGE BODY", 52, "now"],
      ],
      "A",
    );
    expect(rows.map((row) => row.type)).toEqual(["PACKAGE", "PACKAGE BODY"]);
    expect(buildOracleObjectErrorsSql("A", object)).toContain("TYPE = 'PACKAGE BODY'");
    expect(buildOracleObjectErrorsSql("A", object)).toContain(`NAME = 'p"name'`);
    expect(buildOracleObjectIdentitySql("A", object)).toContain("OBJECT_ID");
    expect(buildOracleObjectIdentitySql("A", object)).toContain("STATUS = 'INVALID'");
  });

  it.each([
    ["oracle", "PROCEDURE", 'ALTER PROCEDURE "APP"."P" COMPILE REUSE SETTINGS'],
    ["oracle", "FUNCTION", 'ALTER FUNCTION "APP"."P" COMPILE REUSE SETTINGS'],
    ["oracle", "TRIGGER", 'ALTER TRIGGER "APP"."P" COMPILE REUSE SETTINGS'],
    ["oracle", "PACKAGE", 'ALTER PACKAGE "APP"."P" COMPILE SPECIFICATION REUSE SETTINGS'],
    ["oracle", "PACKAGE BODY", 'ALTER PACKAGE "APP"."P" COMPILE BODY REUSE SETTINGS'],
    ["oracle", "TYPE", 'ALTER TYPE "APP"."T" COMPILE SPECIFICATION REUSE SETTINGS'],
    ["oracle", "TYPE BODY", 'ALTER TYPE "APP"."P" COMPILE BODY REUSE SETTINGS'],
    ["oracle", "VIEW", 'ALTER VIEW "APP"."P" COMPILE'],
    ["oracle", "MATERIALIZED VIEW", 'ALTER MATERIALIZED VIEW "APP"."P" COMPILE'],
    ["oracle", "SYNONYM", 'ALTER SYNONYM "APP"."P" COMPILE'],
    ["oceanbase-oracle", "PROCEDURE", 'ALTER PROCEDURE "APP"."P" COMPILE'],
    ["oceanbase-oracle", "FUNCTION", 'ALTER FUNCTION "APP"."P" COMPILE'],
    ["oceanbase-oracle", "PACKAGE", 'ALTER PACKAGE "APP"."P" COMPILE'],
    ["oceanbase-oracle", "PACKAGE BODY", 'ALTER PACKAGE "APP"."P" COMPILE BODY'],
  ] as const)("builds the engine-specific compile command for %s %s", (dbType, type, expected) => {
    expect(buildOracleCompileSql(dbType, "APP", { name: type === "TYPE" ? "T" : "P", type })).toBe(expected);
  });

  it("treats only the exact PUBLIC dictionary owner as a public synonym", () => {
    expect(buildOracleCompileSql("oracle", "PUBLIC", { name: "EMP", type: "SYNONYM" })).toBe('ALTER PUBLIC SYNONYM "EMP" COMPILE');
    expect(buildOracleCompileSql("oracle", "Public", { name: "EMP", type: "SYNONYM" })).toBe('ALTER SYNONYM "Public"."EMP" COMPILE');
  });

  it("keeps unsupported OceanBase types visible without generating a write", () => {
    expect(oracleCompileUnsupportedReason("oceanbase-oracle", "VIEW")).toBe("unsupported-on-engine");
    expect(oracleCompileUnsupportedReason("oceanbase-oracle", "JAVA CLASS")).toBe("unsupported-type");
    expect(() => buildOracleCompileSql("oceanbase-oracle", "APP", { name: "V", type: "VIEW" })).toThrow();
  });

  it("maps numeric error locations and keeps the database sequence", () => {
    expect(
      mapOracleObjectErrors([
        [2, 18, 7, "second"],
        [1, 4, 3, "first"],
      ]),
    ).toEqual([
      { sequence: 1, line: 4, position: 3, text: "first" },
      { sequence: 2, line: 18, position: 7, text: "second" },
    ]);
  });
});
