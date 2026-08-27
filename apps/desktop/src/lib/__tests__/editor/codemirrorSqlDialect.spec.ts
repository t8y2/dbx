import { describe, expect, it } from "vitest";
import * as langSql from "@codemirror/lang-sql";
import { createDbxCodeMirrorSqlDialect, postgresKeywordSyntaxTerms } from "@/lib/editor/codemirrorSqlDialect";
import type { DatabaseType } from "@/types/database";

describe("codemirrorSqlDialect", () => {
  it("keeps common PostgreSQL identifier names out of keyword highlighting", () => {
    const keywords = new Set(postgresKeywordSyntaxTerms(langSql.PostgreSQL.spec.keywords || "").split(/\s+/));

    expect(keywords.has("select")).toBe(true);
    expect(keywords.has("from")).toBe(true);
    expect(keywords.has("where")).toBe(true);
    expect(keywords.has("id")).toBe(false);
    expect(keywords.has("name")).toBe(false);
    expect(keywords.has("user")).toBe(false);
    expect(keywords.has("count")).toBe(false);
  });

  it("highlights common functions dropped from Postgres/MySQL keyword lists as builtins", () => {
    const postgresBuiltins = new Set(createDbxCodeMirrorSqlDialect(langSql, "postgres", "postgres").spec.builtin?.split(/\s+/));
    const mysqlBuiltins = new Set(createDbxCodeMirrorSqlDialect(langSql, "mysql", "mysql").spec.builtin?.split(/\s+/));

    expect(postgresBuiltins.has("count")).toBe(true);
    expect(postgresBuiltins.has("to_char")).toBe(true);
    expect(mysqlBuiltins.has("ifnull")).toBe(true);
    expect(mysqlBuiltins.has("date_format")).toBe(true);
  });

  it("adds Dolt routines to highlighting without changing standard MySQL", () => {
    const doltBuiltins = new Set(createDbxCodeMirrorSqlDialect(langSql, "mysql", "mysql", "dolt").spec.builtin?.split(/\s+/));
    const mysqlBuiltins = new Set(createDbxCodeMirrorSqlDialect(langSql, "mysql", "mysql", "mysql").spec.builtin?.split(/\s+/));

    expect(doltBuiltins.has("dolt_branch")).toBe(true);
    expect(doltBuiltins.has("dolt_merge")).toBe(true);
    expect(mysqlBuiltins.has("dolt_branch")).toBe(false);
  });

  it("keeps double quotes as identifier delimiters for Oracle-family dialects", () => {
    const databaseTypes: DatabaseType[] = ["oracle", "dameng", "yashandb", "oscar", "oceanbase-oracle"];

    for (const databaseType of databaseTypes) {
      expect(createDbxCodeMirrorSqlDialect(langSql, "mysql", databaseType).spec.doubleQuotedStrings, databaseType).toBe(false);
    }
  });
});
