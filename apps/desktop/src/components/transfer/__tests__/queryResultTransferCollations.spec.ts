import { describe, expect, it } from "vitest";
import { adaptMysqlDdlCollations, mysqlDdlCollations } from "../queryResultTransferDdl";

describe("MySQL transfer collation compatibility", () => {
  const ddl = "CREATE TABLE t (`utf8mb4_0900_ai_ci` TEXT COLLATE 'utf8mb4_0900_ai_ci' DEFAULT 'COLLATE utf8mb4_0900_ai_ci', b TEXT COLLATE `utf8mb4_bin`) DEFAULT CHARSET=utf8mb4 COLLATE=UTF8MB4_0900_AI_CI COMMENT='utf8mb4_0900_ai_ci'; -- COLLATE utf8mb4_0900_ai_ci";

  it("rewrites column/table clauses without changing names, defaults, comments or supported rules", () => {
    const result = adaptMysqlDdlCollations(ddl, ["utf8mb4_unicode_ci", "utf8mb4_unicode_520_ci", "utf8mb4_bin"]);
    expect(result.unsupported).toEqual([]);
    expect(result.changes).toEqual(["utf8mb4_0900_ai_ci → utf8mb4_unicode_520_ci"]);
    expect(result.ddl).toContain("`utf8mb4_0900_ai_ci` TEXT COLLATE utf8mb4_unicode_520_ci DEFAULT 'COLLATE utf8mb4_0900_ai_ci'");
    expect(result.ddl).toContain("COLLATE `utf8mb4_bin`");
    expect(result.ddl).toContain("COLLATE=utf8mb4_unicode_520_ci COMMENT='utf8mb4_0900_ai_ci'; -- COLLATE utf8mb4_0900_ai_ci");
    expect(mysqlDdlCollations(ddl)).toEqual(["utf8mb4_0900_ai_ci", "utf8mb4_bin"]);
  });

  it("preserves the source byte-for-byte when supported", () => {
    expect(adaptMysqlDdlCollations(ddl, ["UTF8MB4_0900_AI_CI", "utf8mb4_bin"])).toEqual({ ddl, changes: [], unsupported: [] });
  });

  it("does not guess replacements for case-sensitive or language-specific rules", () => {
    const sql = "CREATE TABLE t (v TEXT COLLATE utf8mb4_0900_as_cs) COLLATE=utf8mb4_de_pb_0900_ai_ci";
    expect(adaptMysqlDdlCollations(sql, ["utf8mb4_unicode_ci"]).unsupported).toEqual(["utf8mb4_de_pb_0900_ai_ci", "utf8mb4_0900_as_cs"]);
  });

  it("does not query metadata for collation-like text in data", () => {
    expect(mysqlDdlCollations("CREATE TABLE t (`collate` TEXT DEFAULT 'COLLATE utf8mb4_0900_ai_ci') -- COLLATE utf8mb4_0900_ai_ci")).toEqual([]);
  });
});
