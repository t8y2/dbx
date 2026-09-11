import { describe, expect, it } from "vitest";
import { sqlAliasHighlightGroups, type SqlAliasHighlightGroup } from "@/lib/sql/semantic/aliasHighlights";

function spanTexts(sql: string, spans: Array<{ start: number; end: number }>): string[] {
  return spans.map((span) => sql.slice(span.start, span.end));
}

function groupByDeclaration(sql: string, groups: SqlAliasHighlightGroup[]): Map<string, SqlAliasHighlightGroup> {
  return new Map(groups.map((group) => [sql.slice(group.declaration.start, group.declaration.end), group]));
}

describe("sqlAliasHighlightGroups", () => {
  it("highlights an alias declaration, qualifiers, and qualified references", () => {
    const sql = "SELECT u.id, o.amount FROM users u JOIN orders o ON o.user_id = u.id";
    const groups = groupByDeclaration(sql, sqlAliasHighlightGroups(sql));

    expect(spanTexts(sql, [groups.get("u")!.declaration])).toEqual(["u"]);
    expect(spanTexts(sql, groups.get("u")!.qualifiers)).toEqual(["u", "u"]);
    expect(spanTexts(sql, groups.get("u")!.references)).toEqual(["u.id", "u.id"]);
    expect(spanTexts(sql, groups.get("o")!.qualifiers)).toEqual(["o", "o"]);
    expect(spanTexts(sql, groups.get("o")!.references)).toEqual(["o.amount", "o.user_id"]);
  });

  it("keeps a star column inside the reference span", () => {
    const sql = "SELECT u.* FROM users u";
    const groups = groupByDeclaration(sql, sqlAliasHighlightGroups(sql));

    expect(spanTexts(sql, groups.get("u")!.references)).toEqual(["u.*"]);
  });

  it("still returns an unreferenced alias so its declaration can highlight itself", () => {
    const sql = "SELECT id FROM users u";
    const groups = sqlAliasHighlightGroups(sql);

    expect(groups).toHaveLength(1);
    expect(spanTexts(sql, [groups[0].declaration])).toEqual(["u"]);
    expect(groups[0].qualifiers).toEqual([]);
    expect(groups[0].references).toEqual([]);
  });

  it("mixes referenced and unreferenced aliases without dropping either", () => {
    const sql = "SELECT u.id FROM users u, audit_log a";
    const groups = groupByDeclaration(sql, sqlAliasHighlightGroups(sql));

    expect(spanTexts(sql, groups.get("u")!.references)).toEqual(["u.id"]);
    expect(groups.get("a")!.references).toEqual([]);
  });

  it("drops duplicate alias declarations that would produce no spans at all", () => {
    const sql = "SELECT u.id FROM users u, logs u";
    const groups = sqlAliasHighlightGroups(sql);

    expect(groups).toEqual([]);
  });

  it("does not mistake schema.table.column or table function calls for alias references", () => {
    const sql = "SELECT db.users.id FROM db.users";
    const groups = sqlAliasHighlightGroups(sql);

    expect(groups).toEqual([]);
  });

  it("resolves inner alias references to the shadowing subquery block", () => {
    const sql = "SELECT * FROM users u WHERE u.id IN (SELECT ur.role FROM user_roles ur)";
    const groups = sqlAliasHighlightGroups(sql);

    expect(groups).toHaveLength(2);
    expect(
      spanTexts(
        sql,
        groups.map((group) => group.declaration),
      ),
    ).toEqual(["u", "ur"]);
    expect(spanTexts(sql, groups[0].references)).toEqual(["u.id"]);
    expect(spanTexts(sql, groups[1].references)).toEqual(["ur.role"]);
  });

  it("shadows an outer alias reused as the inner subquery alias", () => {
    const sql = "SELECT * FROM users u WHERE u.id IN (SELECT u.role FROM user_roles u)";
    const groups = sqlAliasHighlightGroups(sql);

    expect(groups).toHaveLength(2);
    expect(
      spanTexts(
        sql,
        groups.map((group) => group.declaration),
      ),
    ).toEqual(["u", "u"]);
    expect(spanTexts(sql, groups[0].references)).toEqual(["u.id"]);
    expect(spanTexts(sql, groups[1].references)).toEqual(["u.role"]);
  });

  it("scopes grouped join sources and their group alias separately", () => {
    const sql = "SELECT g.id FROM (users a JOIN orders b ON a.user_id = b.id) g WHERE g.amount > 0";
    const groups = groupByDeclaration(sql, sqlAliasHighlightGroups(sql));

    expect(spanTexts(sql, groups.get("a")!.references)).toEqual(["a.user_id"]);
    expect(spanTexts(sql, groups.get("b")!.references)).toEqual(["b.id"]);
    expect(spanTexts(sql, groups.get("g")!.qualifiers)).toEqual(["g", "g"]);
    expect(spanTexts(sql, groups.get("g")!.references)).toEqual(["g.id", "g.amount"]);
  });

  it("keeps an unaliased parenthesized join transparent to the enclosing scope", () => {
    const sql = "SELECT a.id FROM (users a JOIN orders b ON a.user_id = b.id)";
    const groups = groupByDeclaration(sql, sqlAliasHighlightGroups(sql));

    expect(spanTexts(sql, groups.get("a")!.references)).toEqual(["a.id", "a.user_id"]);
    expect(spanTexts(sql, groups.get("b")!.references)).toEqual(["b.id"]);
  });

  it.each([
    ["unbalanced open parenthesis", "SELECT * FROM (SELECT * FROM users u"],
    ["stray close parenthesis", "SELECT * FROM users u) WHERE u.id > 0"],
    ["unclosed string literal", "SELECT u.id FROM users u WHERE u.name = 'oops"],
    ["unclosed mysql backtick identifier", "SELECT `e`.id FROM users `e"],
    ["truncated before alias", "SELECT u.id FROM users"],
    ["empty statement", ""],
  ] as const)("returns no groups for a %s", (_label, sql) => {
    expect(sqlAliasHighlightGroups(sql, { databaseType: "mysql" })).toEqual([]);
  });

  it("matches mysql backtick-quoted aliases and references", () => {
    const sql = "SELECT `e`.id FROM `analytics`.`events` `e`";
    const groups = groupByDeclaration(sql, sqlAliasHighlightGroups(sql, { databaseType: "mysql" }));

    expect(spanTexts(sql, [groups.get("`e`")!.declaration])).toEqual(["`e`"]);
    expect(spanTexts(sql, groups.get("`e`")!.references)).toEqual(["`e`.id"]);
  });

  it("treats mysql double quotes as strings, not alias qualifiers", () => {
    const sql = 'SELECT "e".id FROM users e';
    const groups = groupByDeclaration(sql, sqlAliasHighlightGroups(sql, { databaseType: "mysql" }));

    expect(groups.get("e")!.references).toEqual([]);
  });

  it("matches sqlite double-quoted aliases and references", () => {
    const sql = 'SELECT "u".id FROM users AS "u"';
    const groups = groupByDeclaration(sql, sqlAliasHighlightGroups(sql, { databaseType: "sqlite" }));

    expect(spanTexts(sql, [groups.get('"u"')!.declaration])).toEqual(['"u"']);
    expect(spanTexts(sql, groups.get('"u"')!.references)).toEqual(['"u".id']);
  });

  it.each([
    ["mysql unquoted alias", { databaseType: "mysql" }, "SELECT u.id FROM users U", true],
    ["mysql backtick alias with different case", { databaseType: "mysql" }, "SELECT `e`.id FROM users `E`", true],
    ["sql server unquoted alias", { databaseType: "sqlserver" }, "SELECT u.id FROM users U", true],
    ["sql server bracket alias", { databaseType: "sqlserver" }, "SELECT [u].id FROM users [U]", true],
    ["sqlite ascii fold", { databaseType: "sqlite" }, "SELECT U.id FROM users u", true],
    ["postgres folds unquoted identifiers", { databaseType: "postgres" }, "SELECT u.id FROM users U", true],
    ["postgres quoted alias keeps its case", { databaseType: "postgres" }, 'SELECT u.id FROM users "U"', false],
    ["oracle folds unquoted identifiers up", { databaseType: "oracle" }, "SELECT U.ID FROM users u", true],
    ["oracle quoted alias keeps its case", { databaseType: "oracle" }, 'SELECT u.id FROM users "u"', false],
    ["generic dialect stays case-sensitive", {}, "SELECT u.id FROM users U", false],
  ] as const)("resolves %s case handling", (_label, options, sql, matches) => {
    const groups = sqlAliasHighlightGroups(sql, options);
    const withReferences = groups.filter((group) => group.references.length > 0);

    expect(withReferences).toHaveLength(matches ? 1 : 0);
  });
});
