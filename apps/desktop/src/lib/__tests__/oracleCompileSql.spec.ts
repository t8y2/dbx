import { describe, expect, it } from "vitest";
import { buildOracleCompileErrorsSql, buildOracleCompileSql, formatOracleCompileErrors, oracleCompileTarget } from "@/lib/database/oracleCompileSql";

describe("oracleCompileSql", () => {
  it.each([
    ["view", "VIEW"],
    ["procedure", "PROCEDURE"],
    ["function", "FUNCTION"],
    ["package", "PACKAGE"],
    ["trigger", "TRIGGER"],
    ["type", "TYPE"],
    ["VIEW", "VIEW"],
    ["PROCEDURE", "PROCEDURE"],
    ["PACKAGE", "PACKAGE"],
  ])("maps %s to %s", (objectType, keyword) => {
    expect(oracleCompileTarget(objectType)?.keyword).toBe(keyword);
    expect(oracleCompileTarget(objectType)?.body).toBe(false);
  });

  // A package and a type have no separate body object, so the body kinds have to reach the
  // body with `COMPILE BODY` on the owning keyword.
  it.each([
    ["package-body", "PACKAGE"],
    ["PACKAGE_BODY", "PACKAGE"],
    ["type-body", "TYPE"],
    ["TYPE_BODY", "TYPE"],
  ])("compiles the body of %s through %s", (objectType, keyword) => {
    expect(buildOracleCompileSql({ objectType, schema: "APP", name: "OBJ" })).toBe(`ALTER ${keyword} "APP"."OBJ" COMPILE BODY;`);
  });

  it("quotes schema and object names while preserving mixed case", () => {
    expect(buildOracleCompileSql({ objectType: "procedure", schema: "AppSchema", name: "doWork" })).toBe('ALTER PROCEDURE "AppSchema"."doWork" COMPILE;');
  });

  it("omits the schema when the caller has none", () => {
    expect(buildOracleCompileSql({ objectType: "view", name: "V_ACTIVE" })).toBe('ALTER VIEW "V_ACTIVE" COMPILE;');
  });

  it("escapes embedded double quotes", () => {
    expect(buildOracleCompileSql({ objectType: "trigger", schema: 'A"Schema', name: 'T"1' })).toBe('ALTER TRIGGER "A""Schema"."T""1" COMPILE;');
  });

  it("returns null for unsupported object kinds or blank names", () => {
    expect(buildOracleCompileSql({ objectType: "sequence", schema: "APP", name: "SEQ_1" })).toBeNull();
    expect(buildOracleCompileSql({ objectType: "procedure", schema: "APP", name: "   " })).toBeNull();
  });

  it("reads the diagnostics of exactly one object back from ALL_ERRORS", () => {
    expect(buildOracleCompileErrorsSql({ schema: "APP", name: "DO_WORK" })).toBe("SELECT LINE, POSITION, TEXT FROM ALL_ERRORS WHERE OWNER = 'APP' AND NAME = 'DO_WORK' ORDER BY SEQUENCE");
  });

  // The tree hands over the dictionary name, so the comparison stays exact: upper-casing it
  // would merge an object created with a quoted lower-case name with a different object.
  it("does not upper-case the object name and escapes quotes in both literals", () => {
    expect(buildOracleCompileErrorsSql({ schema: "a'b", name: "do'work" })).toBe("SELECT LINE, POSITION, TEXT FROM ALL_ERRORS WHERE OWNER = 'a''b' AND NAME = 'do''work' ORDER BY SEQUENCE");
  });

  it("drops the owner predicate when the schema is unknown", () => {
    expect(buildOracleCompileErrorsSql({ name: "DO_WORK" })).toBe("SELECT LINE, POSITION, TEXT FROM ALL_ERRORS WHERE NAME = 'DO_WORK' ORDER BY SEQUENCE");
    expect(buildOracleCompileErrorsSql({ name: "  " })).toBeNull();
  });

  it("renders one diagnostic per line", () => {
    expect(
      formatOracleCompileErrors([
        [12, 5, "PLS-00201: identifier 'MISSING_TABLE' must be declared"],
        [14, 3, "PL/SQL: SQL Statement ignored"],
      ]),
    ).toBe("LINE 12, COL 5: PLS-00201: identifier 'MISSING_TABLE' must be declared\nLINE 14, COL 3: PL/SQL: SQL Statement ignored");
  });

  it("renders a missing line or column as ? rather than dropping the diagnostic", () => {
    expect(formatOracleCompileErrors([[null, undefined, "ORA-00942: table or view does not exist"]])).toBe("LINE ?, COL ?: ORA-00942: table or view does not exist");
  });

  it("ignores rows that are not diagnostics and messages without text", () => {
    expect(formatOracleCompileErrors([[1, 1, "   "], [1, 1], "not a row", null, [2, 2, "PLS-00302: component must be declared"]])).toBe("LINE 2, COL 2: PLS-00302: component must be declared");
  });

  it("returns an empty message for a non-list payload", () => {
    expect(formatOracleCompileErrors(undefined)).toBe("");
    expect(formatOracleCompileErrors({ rows: 3 })).toBe("");
  });
});
