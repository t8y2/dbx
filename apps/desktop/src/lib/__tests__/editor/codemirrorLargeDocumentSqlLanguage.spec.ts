import { describe, expect, it } from "vitest";
import * as langSql from "@codemirror/lang-sql";
import { StreamLanguage, ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { cassandra, msSQL, mySQL, pgSQL, plSQL, sqlite, standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { createLargeDocumentSqlLanguage, largeDocumentSqlStreamParser } from "@/lib/editor/codemirrorLargeDocumentSqlLanguage";
import type { DatabaseType } from "@/types/database";

describe("createLargeDocumentSqlLanguage", () => {
  it.each<[string, Parameters<typeof createLargeDocumentSqlLanguage>[1], DatabaseType | undefined, unknown]>([
    ["mysql family", "mysql", "mysql", mySQL],
    ["postgres family", "postgres", "gaussdb", pgSQL],
    ["sql server", "sqlserver", "sqlserver", msSQL],
    ["oracle family", "oracle", "dameng", plSQL],
    ["sqlite family", "mysql", "sqlite", sqlite],
    ["cassandra", "mysql", "cassandra", cassandra],
    ["clickhouse falls back to standard sql", "clickhouse", "clickhouse", standardSQL],
    ["no database type uses the dialect name", "postgres", undefined, pgSQL],
  ])("follows the same dialect family as the full grammar for %s", (_label, dialectName, databaseType, parser) => {
    expect(largeDocumentSqlStreamParser(langSql, dialectName, databaseType)).toBe(parser);
  });

  it("defaults to the mysql family like the full grammar", () => {
    expect(largeDocumentSqlStreamParser(langSql)).toBe(mySQL);
  });

  it("reuses one language per parser so reconfiguring does not rebuild it", () => {
    expect(createLargeDocumentSqlLanguage(langSql, "mysql", "mysql")).toBe(createLargeDocumentSqlLanguage(langSql, "mysql", "doris"));
  });

  it("still tokenizes SQL so highlighting survives", () => {
    const language = createLargeDocumentSqlLanguage(langSql, "mysql", "mysql");
    expect(language).toBeInstanceOf(StreamLanguage);
    const state = EditorState.create({ doc: "SELECT id FROM t WHERE name = 'x';", extensions: [language] });
    const tree = ensureSyntaxTree(state, state.doc.length, 1000)!;
    const names = new Set<string>();
    tree.iterate({ enter: (node) => void names.add(node.name) });
    expect([...names].some((name) => /keyword/i.test(name))).toBe(true);
    expect([...names].some((name) => /string/i.test(name))).toBe(true);
  });
});
