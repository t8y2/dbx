import { describe, expect, it } from "vitest";
import * as langSql from "@codemirror/lang-sql";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";

function parse(sql: string, enabled = true) {
  const dialect = createDbxCodeMirrorSqlDialect(langSql, "mysql", "mysql", undefined, { databaseType: "mysql", enabledSyntaxes: enabled ? ["mybatis", "sqlserver"] : [] });
  return dialect.language.parser.parse(sql);
}
function classesAt(sql: string, text: string, enabled = true) {
  const position = sql.indexOf(text);
  const classes: string[] = [];
  highlightTree(
    parse(sql, enabled),
    tagHighlighter([
      { tag: tags.comment, class: "comment" },
      { tag: tags.keyword, class: "keyword" },
      { tag: tags.variableName, class: "parameter" },
    ]),
    (from, to, style) => {
      if (from <= position && to > position) classes.push(style);
    },
  );
  return classes.join(" ");
}

describe("MyBatis parameter SQL highlighting", () => {
  it("keeps the parameter and following predicates out of MySQL comments", () => {
    const sql = "SELECT * FROM packets WHERE htm = #{packetCode} AND 1 = 1\nORDER BY djbth";
    expect(parse(sql).resolveInner(sql.indexOf("#{") + 2, 1).name).toBe("SqlParameter");
    expect(classesAt(sql, "#{packetCode}")).toBe("parameter");
    expect(classesAt(sql, "AND")).toContain("keyword");
    expect(classesAt(sql, "AND")).not.toContain("comment");
    expect(classesAt(sql, "ORDER")).toContain("keyword");
  });
  it("recognizes multiple parameters without losing real comments and quoted text", () => {
    const sql = "SELECT 1 WHERE a = #{first} AND b = #{second} AND c = '#{literal}' # real #{comment}";
    expect(classesAt(sql, "#{first}")).toBe("parameter");
    expect(classesAt(sql, "#{second}")).toBe("parameter");
    expect(classesAt(sql, "#{literal}")).not.toContain("parameter");
    expect(classesAt(sql, "# real")).toContain("comment");
    expect(classesAt(sql, "#{comment}")).toContain("comment");
  });
  it.each(["# real #{id} AND 1 = 1", "-- #{id} AND 1 = 1", "/* #{id} AND 1 = 1 */", "#{} AND 1 = 1", "#{not a name} AND 1 = 1", "#{unclosed AND 1 = 1"])("retains ordinary and invalid-placeholder comments: %s", (sql) => {
    expect(classesAt(sql, "AND")).toContain("comment");
  });
  it("respects a disabled MyBatis syntax", () => {
    const sql = "SELECT 1 WHERE id = #{id} AND 1 = 1";
    expect(classesAt(sql, "AND", false)).toContain("comment");
  });
  it("updates the parse when an edit changes a parameter into a real comment", () => {
    const sql = "SELECT 1 WHERE id = #{id} AND 1 = 1";
    const dialect = createDbxCodeMirrorSqlDialect(langSql, "mysql", "mysql");
    const state = EditorState.create({ doc: sql, extensions: [dialect.extension] });
    ensureSyntaxTree(state, sql.length, 1000);
    const changed = state.update({ changes: { from: sql.indexOf("{"), to: sql.indexOf("{") + 1, insert: " " } }).state;
    ensureSyntaxTree(changed, changed.doc.length, 1000);
    expect(syntaxTree(changed).resolveInner(changed.doc.toString().indexOf("AND"), 1).name).toBe("LineComment");
  });
  it("handles many placeholders on one line without recursive nesting", () => {
    const sql = `SELECT 1 WHERE ${Array.from({ length: 1000 }, (_, index) => `c${index} = #{p${index}}`).join(" AND ")}`;
    const tree = parse(sql);
    expect(tree.resolveInner(sql.lastIndexOf("#{") + 2, 1).name).toBe("SqlParameter");
  });
});
