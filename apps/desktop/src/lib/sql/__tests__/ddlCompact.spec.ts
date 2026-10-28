import { describe, expect, it } from "vitest";
import { compactDdlSql } from "../ddlCompact";
import { applyDdlTextPreferences } from "../ddlPreferences";
import { tokenizeSqlSemantic } from "../semantic/tokens";

describe("Oracle DDL compact SQL", () => {
  it.each(["oracle", "oceanbase-oracle"] as const)("preserves independent index bindings with default %s text preferences", (type) => {
    const sql = 'CREATE   TABLE "Dest"."T" ("ID" NUMBER, "V" VARCHAR2(30) DEFAULT q\'[a  b]\') PCTFREE 10;\n\nCREATE   UNIQUE INDEX "Dest"."IX" ON "Dest"."T" ("ID") TABLESPACE "DATA";\nALTER   TABLE "Dest"."T" ADD CONSTRAINT "PK" PRIMARY KEY ("ID") USING INDEX "Dest"."IX" ENABLE;';
    const result = applyDdlTextPreferences(sql, type, { includeDdlStorage: false, compactDdlSql: true });
    expect(result).not.toContain("PCTFREE");
    if (type === "oracle") expect(result).not.toContain("TABLESPACE");
    else expect(result).toContain('TABLESPACE "DATA"');
    expect(result).toContain('CREATE UNIQUE INDEX "Dest"."IX"');
    expect(result).toContain('USING INDEX "Dest"."IX" ENABLE');
    expect(result).toContain("q'[a  b]'");
    expect(applyDdlTextPreferences(sql, type, { includeDdlStorage: true, compactDdlSql: false })).toBe(sql);
  });

  it.each(["oracle", "oceanbase-oracle"] as const)("removes alignment and blank lines without changing %s tokens", (type) => {
    const sql = 'CREATE   TABLE "T  表" (\r\n\r\n  "ID"    NUMBER,\r\n  "V" VARCHAR2(50) DEFAULT q\'[a  b\n\n c]\'\r\n);\r\n-- keep  comment\r\n\r\nCREATE /*+ keep  hint */  INDEX "I" ON "T  表"("ID");';
    const result = compactDdlSql(sql, type);
    expect(result).toContain('CREATE TABLE "T  表" (\r\n  "ID" NUMBER');
    expect(result).toContain("-- keep  comment\r\nCREATE");
    expect(tokenizeSqlSemantic(result, "oracle").map((token) => [token.kind, token.text])).toEqual(tokenizeSqlSemantic(sql, "oracle").map((token) => [token.kind, token.text]));
    expect(compactDdlSql(result, type)).toBe(result);
  });

  it.each(["SELECT 'unclosed", 'CREATE TABLE "unclosed', "SELECT /* unclosed"])("preserves incomplete input %s", (sql) => {
    expect(compactDdlSql(sql, "oracle")).toBe(sql);
  });

  it("preserves operator separation, procedure boundaries and national literals", () => {
    const sql = "CREATE   PROCEDURE P AS\nBEGIN\n  X := N'中  文'; -- keep\n\n  X := nq'{a  b}';\n  X := 1 -  - 2;\n  X := 1 /  * 2;\nEND;\n/\n";
    const result = compactDdlSql(sql, "oracle");
    expect(result).toContain("1 - - 2");
    expect(result).toContain("1 / * 2");
    expect(result).toContain("END;\n/\n");
    expect(tokenizeSqlSemantic(result, "oracle").map((token) => token.text)).toEqual(tokenizeSqlSemantic(sql, "oracle").map((token) => token.text));
  });

  it("does not change other dialects", () => {
    const sql = "CREATE   TABLE t (id int)";
    expect(compactDdlSql(sql, "mysql")).toBe(sql);
    expect(compactDdlSql(sql, undefined)).toBe(sql);
  });
});
