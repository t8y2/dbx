import { describe, expect, it } from "vitest";
import * as langSql from "@codemirror/lang-sql";
import { StreamLanguage, ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { cassandra, msSQL, mySQL, pgSQL, plSQL, sqlite, standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { createLargeDocumentSqlLanguage, largeDocumentSqlStreamParser } from "@/lib/editor/codemirrorLargeDocumentSqlLanguage";
import type { DatabaseType } from "@/types/database";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";

function tokenStyles(sql: string, text: string, mybatis = true) {
  const language = createLargeDocumentSqlLanguage(langSql, "mysql", "mysql", { enabledSyntaxes: mybatis ? ["mybatis"] : [] });
  const state = EditorState.create({ doc: sql, extensions: [language] });
  const tree = ensureSyntaxTree(state, sql.length, 1000)!;
  const position = sql.indexOf(text);
  const classes: string[] = [];
  highlightTree(
    tree,
    tagHighlighter([
      { tag: tags.comment, class: "comment" },
      { tag: tags.variableName, class: "parameter" },
    ]),
    (from, to, style) => {
      if (from <= position && to > position) classes.push(style);
    },
  );
  return classes.join(" ");
}

describe("createLargeDocumentSqlLanguage", () => {
  it("keeps MyBatis parameters and following SQL out of comments in stream mode", () => {
    const sql = "SELECT id FROM packets WHERE id = #{packetCode} AND x = #{other} # real comment";
    expect(tokenStyles(sql, "#{packetCode}")).toContain("parameter");
    expect(tokenStyles(sql, "#{other}")).toContain("parameter");
    expect(tokenStyles(sql, "AND")).not.toContain("comment");
    expect(tokenStyles(sql, "# real")).toContain("comment");
  });

  it.each(["SELECT '#{quoted}' AS body, #{id}", "SELECT 'start\n#{quoted}' AS body, #{id}", "SELECT /* start\n#{quoted}\n*/ #{id}"])("preserves quoted and multiline comment content: %s", (sql) => {
    expect(tokenStyles(sql, "#{quoted}")).not.toContain("parameter");
    expect(tokenStyles(sql, "#{id}")).toContain("parameter");
  });

  it("keeps normal hash comments and disabled MyBatis syntax as comments", () => {
    expect(tokenStyles("SELECT 1 # real #{id}", "#{id}")).toContain("comment");
    expect(tokenStyles("SELECT 1 WHERE id = #{id} AND 1 = 1", "AND", false)).toContain("comment");
    expect(tokenStyles("SELECT 1 #{} AND 1 = 1", "AND")).toContain("comment");
  });

  it("caches enabled and disabled parameter languages separately", () => {
    const disabled = createLargeDocumentSqlLanguage(langSql, "mysql", "mysql", { enabledSyntaxes: [] });
    const enabled = createLargeDocumentSqlLanguage(langSql, "mysql", "mysql", { enabledSyntaxes: ["mybatis"] });
    expect(disabled).not.toBe(enabled);
    expect(enabled).toBe(createLargeDocumentSqlLanguage(langSql, "mysql", "doris", { enabledSyntaxes: ["mybatis"] }));
  });
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
