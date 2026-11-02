import { describe, expect, it } from "vitest";
import { sqlWithoutCommentsForCopy } from "@/lib/sql/sqlWithoutCommentsForCopy";

describe("sqlWithoutCommentsForCopy", () => {
  it("strips commented-out predicates and blank lines left behind", () => {
    const sql = `select *
from (
  select 1 as id, 'alpha' as keyword
) demo_tasks
where 1=1
-- and id in (42)
and keyword in ('alpha')
-- and keyword like "%beta%"
-- and env = 'prod'
-- and create_time > '2020-01-01'
order by id desc`;

    expect(sqlWithoutCommentsForCopy(sql, "mysql")).toBe(`select *
from (
  select 1 as id, 'alpha' as keyword
) demo_tasks
where 1=1
and keyword in ('alpha')
order by id desc`);
  });

  it("keeps -- and # that sit inside string literals", () => {
    expect(sqlWithoutCommentsForCopy("select '-- not comment', '# also not' from t -- drop", "mysql")).toBe("select '-- not comment', '# also not' from t");
  });

  it("strips MySQL # line comments", () => {
    expect(sqlWithoutCommentsForCopy("select 1 # note\nfrom t", "mysql")).toBe("select 1\nfrom t");
  });

  it("does not treat PostgreSQL #> as a hash comment", () => {
    expect(sqlWithoutCommentsForCopy("select data #> '{a}' -- note\nfrom t", "postgres")).toBe("select data #> '{a}'\nfrom t");
  });

  it("keeps optimizer hints and MySQL executable comments", () => {
    expect(sqlWithoutCommentsForCopy("select /*+ INDEX(t i) */ id from t /* docs */", "oracle")).toBe("select /*+ INDEX(t i) */ id from t");
    expect(sqlWithoutCommentsForCopy("select /*!40101 1 */ from t -- skip", "mysql")).toBe("select /*!40101 1 */ from t");
  });

  it("returns empty input unchanged", () => {
    expect(sqlWithoutCommentsForCopy("")).toBe("");
  });

  it.each([
    ["SELECT/* note */1", "SELECT 1"],
    ["SELECT id/* note */FROM items", "SELECT id FROM items"],
    ["SELECT 1-/* note */-2", "SELECT 1- -2"],
  ])("preserves token boundaries in %s", (sql, expected) => {
    expect(sqlWithoutCommentsForCopy(sql, "postgres")).toBe(expected);
  });

  it.each(["SELECT 'line1\n\nline2'", "SELECT 'line1 \nline2'", "SELECT $$line1\n\nline2$$", 'SELECT "line1 \n\nline2" FROM items', "SELECT 'unfinished literal \n "])("preserves whitespace inside non-comment tokens in %s", (sql) => {
    expect(sqlWithoutCommentsForCopy(sql, "postgres")).toBe(sql);
  });

  it("removes only exterior blank lines and preserves CRLF separators", () => {
    expect(sqlWithoutCommentsForCopy("SELECT 1\r\n-- note\r\n\r\nFROM items", "postgres")).toBe("SELECT 1\r\nFROM items");
  });

  it("preserves multiline executable comments and optimizer hints", () => {
    const sql = "SELECT /*!40101 1\n\n + 2 */ /*+\n\n INDEX(items idx) */ FROM items";
    expect(sqlWithoutCommentsForCopy(sql, "mysql")).toBe(sql);
  });
});
