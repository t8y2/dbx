import { describe, expect, it } from "vitest";
import { mapQueryEditorFormatSelection } from "@/lib/editor/queryEditorFormatSelection";
import { formatSqlForEditing } from "@/lib/sql/sqlFormatter";

function occurrence(text: string, needle: string, ordinal: number): number {
  let index = -1;
  for (let current = 0; current <= ordinal; current += 1) {
    index = text.indexOf(needle, index + 1);
    if (index < 0) throw new Error(`Missing occurrence ${ordinal} of ${needle}`);
  }
  return index;
}

describe("mapQueryEditorFormatSelection", () => {
  it("keeps the caret in the same keyword and token after formatting inserts earlier newlines", async () => {
    const source = "select id, name, email, status, created_at from users where status = 'active' and tenant_id = 42";
    const formatted = await formatSqlForEditing(source, "mysql");
    const keywordCaret = source.indexOf("where") + 2;
    const tokenCaret = source.indexOf("status", source.indexOf("where")) + 3;

    expect(formatted.slice(0, formatted.indexOf("WHERE"))).toContain("\n");
    expect(mapQueryEditorFormatSelection(source, formatted, { anchor: keywordCaret, head: keywordCaret }, "mysql")).toEqual({
      anchor: formatted.indexOf("WHERE") + 2,
      head: formatted.indexOf("WHERE") + 2,
    });
    expect(mapQueryEditorFormatSelection(source, formatted, { anchor: tokenCaret, head: tokenCaret }, "mysql")).toEqual({
      anchor: formatted.indexOf("status", formatted.indexOf("WHERE")) + 3,
      head: formatted.indexOf("status", formatted.indexOf("WHERE")) + 3,
    });
  });

  it("maps repeated tokens by their stable ordinal instead of searching for the first text match", async () => {
    const source = "select status, status from users where status = 'status' order by status;";
    const formatted = await formatSqlForEditing(source, "mysql");
    const caret = occurrence(source, "status", 2) + 4;
    const expected = occurrence(formatted, "status", 2) + 4;

    expect(mapQueryEditorFormatSelection(source, formatted, { anchor: caret, head: caret }, "mysql")).toEqual({ anchor: expected, head: expected });
  });

  it.each([
    ["string", "'-- repeated text'", 0, 5],
    ["block comment", "/* repeated text */", 0, 6],
    ["line comment", "-- repeated text", 1, 4],
    ["trailing string", "'repeated text'", 0, 4],
  ] as const)("maps a caret inside a %s token without confusing its contents for SQL", (_name, token, ordinal, offset) => {
    const source = "select '-- repeated text' as note, value /* repeated text */ from logs -- repeated text\nwhere value = 'repeated text';";
    const formatted = "SELECT\n  '-- repeated text' AS note,\n  value /* repeated text */\nFROM logs -- repeated text\nWHERE value = 'repeated text';";
    const caret = occurrence(source, token, ordinal) + offset;
    const expected = occurrence(formatted, token, ordinal) + offset;

    expect(mapQueryEditorFormatSelection(source, formatted, { anchor: caret, head: caret }, "mysql")).toEqual({ anchor: expected, head: expected });
  });

  it("maps a caret proportionally within changed whitespace between stable tokens", () => {
    const source = "SELECT id      FROM users";
    const formatted = "SELECT id\nFROM users";
    const caret = source.indexOf("id") + 5;
    const mapped = mapQueryEditorFormatSelection(source, formatted, { anchor: caret, head: caret }, "mysql").head;

    expect(mapped).toBeGreaterThanOrEqual(formatted.indexOf("id") + 2);
    expect(mapped).toBeLessThanOrEqual(formatted.indexOf("FROM"));
  });

  it("keeps unchanged formatter output and its selection untouched", () => {
    const source = "SELECT id FROM users;";
    expect(mapQueryEditorFormatSelection(source, source, { anchor: 18, head: 7 }, "mysql")).toEqual({ anchor: 18, head: 7 });
  });

  it("preserves the selected formatted range and its direction", async () => {
    const source = "select id, name from users where active = 1";
    const formatted = await formatSqlForEditing(source, "mysql");

    expect(mapQueryEditorFormatSelection(source, formatted, { anchor: source.length, head: 0 }, "mysql")).toEqual({
      anchor: formatted.length,
      head: 0,
    });
  });

  it("stays in the corresponding statement when changed tokens require the relative fallback", () => {
    const source = "select one; select old_value from old_table;";
    const formatted = "SELECT one;\n\nEXECUTE completely_different_expression;";
    const caret = source.indexOf("old_value") + 4;
    const mapped = mapQueryEditorFormatSelection(source, formatted, { anchor: caret, head: caret }, "mysql").head;
    const secondStatement = formatted.indexOf("EXECUTE");

    expect(mapped).toBeGreaterThanOrEqual(secondStatement);
    expect(mapped).toBeLessThan(formatted.lastIndexOf(";"));
  });

  it("uses the formatted document end when the corresponding statement is unavailable", () => {
    const source = "select one; select two;";
    const formatted = "SELECT one;";
    const caret = source.indexOf("two") + 1;

    expect(mapQueryEditorFormatSelection(source, formatted, { anchor: caret, head: caret }, "mysql")).toEqual({
      anchor: formatted.length,
      head: formatted.length,
    });
  });

  it("leaves the caret untouched when a parse failure makes the formatter return the source", async () => {
    const source = "SELECT 1 .";
    const formatted = await formatSqlForEditing(source, "generic");
    const caret = source.indexOf("1");

    expect(formatted).toBe(source);
    expect(mapQueryEditorFormatSelection(source, formatted, { anchor: caret, head: caret }, "generic")).toEqual({ anchor: caret, head: caret });
  });
});
