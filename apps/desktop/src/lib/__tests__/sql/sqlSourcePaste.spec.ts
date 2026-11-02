import { describe, expect, it } from "vitest";
import { restoreSqlFromSourcePaste, SQL_SOURCE_PASTE_MAX_LENGTH } from "@/lib/sql/sqlSourcePaste";

describe("restoreSqlFromSourcePaste", () => {
  it("restores the Java string concatenation from the issue example", () => {
    const source = ['"SELECT * " +', '"FROM users \\n " +', '"WHERE id = 1"'].join("\n");
    expect(restoreSqlFromSourcePaste(source)).toEqual({
      sql: "SELECT * FROM users \n WHERE id = 1",
      changed: true,
    });
  });

  it("drops the optional assignment prefix and trailing statement terminator", () => {
    const source = ['String sql = "SELECT id, name " +', '             "FROM users " +', '             "WHERE id = ?";'].join("\n");
    expect(restoreSqlFromSourcePaste(source)).toEqual({
      sql: "SELECT id, name FROM users WHERE id = ?",
      changed: true,
    });
  });

  it("leaves bare single-literal assignments that only contain a keyword untouched", () => {
    expect(restoreSqlFromSourcePaste("status = 'DELETE'")).toEqual({ sql: "status = 'DELETE'", changed: false });
    expect(restoreSqlFromSourcePaste("users.name = 'DESC'")).toEqual({ sql: "users.name = 'DESC'", changed: false });
    expect(restoreSqlFromSourcePaste("label = 'select'")).toEqual({ sql: "label = 'select'", changed: false });
  });

  it("restores bare assignments only when multiple literals are concatenated", () => {
    const source = 'sql = "SELECT * " +\n     "FROM users"';
    expect(restoreSqlFromSourcePaste(source)).toEqual({
      sql: "SELECT * FROM users",
      changed: true,
    });
  });

  it("restores Go short-declaration assignments with a single literal", () => {
    expect(restoreSqlFromSourcePaste('query := "SELECT 1"')).toEqual({
      sql: "SELECT 1",
      changed: true,
    });
  });

  it("keeps unknown escape sequences intact for LIKE patterns", () => {
    const source = "\"SELECT * FROM t WHERE name LIKE '100\\%'\"";
    expect(restoreSqlFromSourcePaste(source)).toEqual({
      sql: "SELECT * FROM t WHERE name LIKE '100\\%'",
      changed: true,
    });
  });

  it("joins implicitly concatenated Python literals", () => {
    const source = ['sql = ("SELECT * "', '       "FROM users "', '       "WHERE id = 1")'].join("\n");
    expect(restoreSqlFromSourcePaste(source)).toEqual({
      sql: "SELECT * FROM users WHERE id = 1",
      changed: true,
    });
  });

  it("joins PHP dotted concatenation", () => {
    expect(restoreSqlFromSourcePaste('"SELECT * " . "FROM users"')).toEqual({
      sql: "SELECT * FROM users",
      changed: true,
    });
  });

  it("unquotes a single literal that covers the whole clipboard", () => {
    expect(restoreSqlFromSourcePaste('"SELECT id FROM users"')).toEqual({
      sql: "SELECT id FROM users",
      changed: true,
    });
  });

  it("restores escaped quotes and tabs", () => {
    const source = '"SELECT * FROM users " +\n\'WHERE name = \\"Bob\\"\' + "\\tAND id = 1"';
    expect(restoreSqlFromSourcePaste(source)).toEqual({
      sql: 'SELECT * FROM users WHERE name = "Bob"\tAND id = 1',
      changed: true,
    });
  });

  it("keeps JS template literal interpolations verbatim", () => {
    const source = ["`SELECT * FROM ${table}` +", "` WHERE id = ${id}`"].join("\n");
    expect(restoreSqlFromSourcePaste(source)).toEqual({
      sql: "SELECT * FROM ${table} WHERE id = ${id}",
      changed: true,
    });
  });

  it("restores Java text blocks", () => {
    const source = 'String sql = """\n    SELECT *\n    FROM users\n    WHERE id = 1\n    """;';
    expect(restoreSqlFromSourcePaste(source)).toEqual({
      sql: "SELECT *\n    FROM users\n    WHERE id = 1",
      changed: true,
    });
  });

  it("keeps backslashes inside Python raw strings", () => {
    expect(restoreSqlFromSourcePaste('r"SELECT * FROM users WHERE path = C:\\tmp"')).toEqual({
      sql: "SELECT * FROM users WHERE path = C:\\tmp",
      changed: true,
    });
  });

  it("unescapes doubled quotes in C# verbatim strings", () => {
    expect(restoreSqlFromSourcePaste('@"SELECT * FROM users WHERE name = ""Bob"""')).toEqual({
      sql: 'SELECT * FROM users WHERE name = "Bob"',
      changed: true,
    });
  });

  it("keeps leading SQL comments in the restored statement", () => {
    expect(restoreSqlFromSourcePaste('"/* hint */ " + "SELECT 1"')).toEqual({
      sql: "/* hint */ SELECT 1",
      changed: true,
    });
  });

  it("leaves plain SQL untouched", () => {
    const source = "SELECT * FROM users WHERE name = 'Bob'";
    expect(restoreSqlFromSourcePaste(source)).toEqual({ sql: source, changed: false });
  });

  it("leaves source strings that are not SQL untouched", () => {
    const source = '"hello " +\n"world"';
    expect(restoreSqlFromSourcePaste(source)).toEqual({ sql: source, changed: false });
  });

  it("leaves SQL string concatenation with || untouched", () => {
    const source = "'SELECT * ' || 'FROM users'";
    expect(restoreSqlFromSourcePaste(source)).toEqual({ sql: source, changed: false });
  });

  it("leaves concatenations with non-literal operands untouched", () => {
    const source = 'query = "SELECT * FROM users WHERE id = " + userId';
    expect(restoreSqlFromSourcePaste(source)).toEqual({ sql: source, changed: false });
  });

  it("leaves multiple statements on separate lines untouched", () => {
    const source = '"SELECT 1";\n"SELECT 2";';
    expect(restoreSqlFromSourcePaste(source)).toEqual({ sql: source, changed: false });
  });

  it("leaves unterminated literals untouched", () => {
    const source = '"SELECT * FROM users';
    expect(restoreSqlFromSourcePaste(source)).toEqual({ sql: source, changed: false });
  });

  it("ignores empty and whitespace-only input", () => {
    expect(restoreSqlFromSourcePaste("")).toEqual({ sql: "", changed: false });
    expect(restoreSqlFromSourcePaste("   \n  ")).toEqual({ sql: "   \n  ", changed: false });
  });

  it("ignores input longer than the configured limit", () => {
    const source = `"SELECT * FROM users"`;
    expect(restoreSqlFromSourcePaste(source, 4)).toEqual({ sql: source, changed: false });
    expect(SQL_SOURCE_PASTE_MAX_LENGTH).toBeGreaterThan(0);
  });

  it("skips empty literals when joining", () => {
    expect(restoreSqlFromSourcePaste('"SELECT * " + "" + "FROM users"')).toEqual({
      sql: "SELECT * FROM users",
      changed: true,
    });
  });
});
