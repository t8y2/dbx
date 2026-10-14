import { describe, expect, it } from "vitest";
import { applySqlKeywordCase, loadSqlKeywordSpans } from "@/lib/sql/sqlKeywordCase";

async function convert(sql: string, mode: "upper" | "lower", dialect: Parameters<typeof loadSqlKeywordSpans>[1] = "mysql", range?: { from: number; to: number }) {
  const spans = await loadSqlKeywordSpans(sql, dialect);
  expect(spans).not.toBeNull();
  return applySqlKeywordCase(sql, range ?? { from: 0, to: sql.length }, mode, spans!);
}

describe("loadSqlKeywordSpans", () => {
  it("returns null for a dialect with no SQL grammar", async () => {
    expect(await loadSqlKeywordSpans("MATCH (n) RETURN n", "cypher")).toBeNull();
  });

  it("returns an empty list for blank input", async () => {
    expect(await loadSqlKeywordSpans("   \n ", "mysql")).toEqual([]);
  });

  it("declines input the lexer rejects instead of guessing", async () => {
    // An unclosed string literal is a normal mid-typing state; the caller must
    // leave the document alone rather than re-case a partial guess.
    expect(await loadSqlKeywordSpans("select 'unclosed from t", "postgres")).toBeNull();
  });

  it("reports one span per multi-word clause, not one per word", async () => {
    const sql = "select a from t group by a";
    const spans = await loadSqlKeywordSpans(sql, "mysql");
    const texts = spans!.map((span) => sql.slice(span.from, span.to));
    expect(texts).toEqual(["select", "from", "group by"]);
  });
});

describe("applySqlKeywordCase", () => {
  it("converts keywords and leaves identifiers alone (#11828)", async () => {
    await expect(convert("select id, name from users where id = 1", "upper")).resolves.toBe("SELECT id, name FROM users WHERE id = 1");
    await expect(convert("SELECT id, name FROM users WHERE id = 1", "lower")).resolves.toBe("select id, name from users where id = 1");
  });

  it("re-cases a multi-word clause as a unit and leaves look-alike identifiers alone", async () => {
    // PostgreSQL lexes `key` as an identifier, and `by` as one outside the
    // clause, so only the clause moves. A plain word list would have
    // upper-cased both columns — the exact corruption this must avoid.
    await expect(convert("select by, key from t group by by", "upper", "postgres")).resolves.toBe("SELECT by, key FROM t GROUP BY by");
    // MySQL genuinely reserves `by`/`key`, and its own formatter upper-cases
    // them too; matching 格式化 is the contract here.
    await expect(convert("select by, key from t group by by", "upper", "mysql")).resolves.toBe("SELECT BY, KEY FROM t GROUP BY BY");
  });

  it("protects string literals, quoted identifiers and comments", async () => {
    const sql = `select 'select from' as s, "key" from t -- group by\nwhere x = 'AND'`;
    await expect(convert(sql, "upper")).resolves.toBe(`SELECT 'select from' AS s, "key" FROM t -- group by\nWHERE x = 'AND'`);
  });

  it("leaves MySQL backtick identifiers intact", async () => {
    await expect(convert("select `select`, `from` from t", "upper")).resolves.toBe("SELECT `select`, `from` FROM t");
  });

  it("does not touch function names or data types", async () => {
    // The toolbar toggles *keyword* case; functions/data types follow their own
    // settings, exactly as sql-formatter's keywordCase does.
    await expect(convert("select count(*), cast(a as int) from t", "upper")).resolves.toBe("SELECT count(*), cast(a AS int) FROM t");
  });

  it("converts CASE expressions and logical operators", async () => {
    await expect(convert("select case when a then b else c end from t where x and y or z", "upper")).resolves.toBe("SELECT CASE WHEN a THEN b ELSE c END FROM t WHERE x AND y OR z");
  });

  it("re-cases backtick-quoted identifiers pasted into a PostgreSQL editor", async () => {
    // DBX's formatter options treat backticks as opaque under PostgreSQL; the
    // keyword scan has to tolerate them for the same reason.
    await expect(convert("select `weird` from t", "upper", "postgres")).resolves.toBe("SELECT `weird` FROM t");
  });

  it("converts only the requested slice, for the caller to dispatch", async () => {
    // The return value replaces [from, to) at the call site, so it is the
    // converted range itself and not the whole document.
    const sql = "select a from t";
    const from = sql.indexOf("from");
    const spans = await loadSqlKeywordSpans(sql, "mysql");
    expect(applySqlKeywordCase(sql, { from, to: from + 4 }, "upper", spans!)).toBe("FROM");
  });

  it("returns the range unchanged when it holds no keyword", async () => {
    const sql = "select status, name from t";
    const from = sql.indexOf("status");
    await expect(convert(sql, "upper", "mysql", { from, to: from + 6 })).resolves.toBe("status");
  });

  it("converts every dialect's own clause vocabulary", async () => {
    await expect(convert("select top 5 a from t", "upper", "sqlserver")).resolves.toBe("SELECT TOP 5 a FROM t");
    await expect(convert("select a from t minus select b from u", "upper", "oracle")).resolves.toBe("SELECT a FROM t MINUS SELECT b FROM u");
  });
});
