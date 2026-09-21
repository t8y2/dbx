import { describe, expect, it } from "vitest";
import * as langSql from "@codemirror/lang-sql";
import { sqlPlaceholderParserInput } from "@/lib/editor/codemirrorSqlPlaceholderInput";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";

function inputFor(sql: string, onRead = (_from: number, _to: number) => {}) {
  return {
    length: sql.length,
    lineChunks: false,
    chunk: (from: number) => sql.slice(from, from + 11),
    read: (from: number, to: number) => {
      onRead(from, to);
      return sql.slice(from, to);
    },
  };
}

describe("incremental SQL placeholder input", () => {
  it.each([4093, 4094, 4095, 4096, 4097])("keeps Unicode placeholders intact across a chunk starting at %s", (start) => {
    const sql = `${" ".repeat(start)}#{𠀀.编号} AND active = 1`;
    const input = sqlPlaceholderParserInput(inputFor(sql));
    expect(input.read(start, sql.length)).toBe("?        AND active = 1");
    const dialect = createDbxCodeMirrorSqlDialect(langSql, "mysql", "mysql");
    const tree = dialect.language.parser.parse(inputFor(`SELECT 1 ${sql}`));
    expect(tree.resolveInner(9 + sql.indexOf("AND") + 1).name).toBe("Keyword");
  });

  it("preserves newlines in placeholders accepted by the shared scanner", () => {
    const sql = "SELECT #{\n  工厂编号\n} AS id";
    const input = sqlPlaceholderParserInput(inputFor(sql));
    expect(input.read(0, sql.length)).toBe("SELECT ? \n      \n  AS id");
  });

  it("preserves astral names when a long placeholder body crosses the scan boundary", () => {
    const placeholder = `#{${"a".repeat(4095)}𠀀a}`;
    const sql = `${placeholder} AND active = 1`;
    const input = sqlPlaceholderParserInput(inputFor(sql));
    expect(input.read(0, sql.length)).toBe(`?${" ".repeat(placeholder.length - 1)} AND active = 1`);
  });

  it("reads long whitespace or identifier runs in linear work during a full parse", () => {
    for (const character of [" ", "a"]) {
      const sql = `${character.repeat(65_536)} #{id} AND active = 1`;
      let readCharacters = 0;
      const input = sqlPlaceholderParserInput(
        inputFor(sql, (from, to) => {
          readCharacters += to - from;
        }),
      );
      expect(input.read(0, sql.length)).toBe(`${character.repeat(65_536)} ?     AND active = 1`);
      expect(readCharacters).toBeLessThan(sql.length * 12);
    }
  });

  it("does not scan an unchanged script prefix for a range parse", () => {
    const prefix = "SELECT 1;\n".repeat(100_000);
    const sql = `${prefix}SELECT #{id} AND active = 1`;
    let earliestRead = sql.length;
    let readCharacters = 0;
    const input = inputFor(sql, (from, to) => {
      earliestRead = Math.min(earliestRead, from);
      readCharacters += to - from;
    });
    const dialect = createDbxCodeMirrorSqlDialect(langSql, "mysql", "mysql");
    dialect.language.parser.parse(input, [], [{ from: prefix.length, to: sql.length }]);
    expect(earliestRead).toBeGreaterThan(prefix.length - 8192);
    expect(readCharacters).toBeLessThan(20_000);
  });
});
