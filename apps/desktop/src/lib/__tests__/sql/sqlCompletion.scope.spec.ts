import { describe, expect, it } from "vitest";
import { buildSqlCompletionItemsFromContext, getSqlCompletionContext, type SqlCompletionColumn } from "@/lib/sql/sqlCompletion";
import { sqlCompletionContextFromSemantic } from "@/lib/sql/semantic/completion";
import { SqlCompletionAnalysisEngine } from "@/lib/sql/sqlCompletionAnalysis";
import { sqlFixtureCursor } from "@/lib/sql/semantic/fixtures";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";
import type { SqlSemanticBuildOptions } from "@/lib/sql/semantic/types";

function complete(markedSql: string, semantic: boolean, editorAnalysis = false, options: SqlSemanticBuildOptions = { databaseType: "postgres", dialect: "postgres" }) {
  const { sql, cursor } = sqlFixtureCursor(markedSql);
  const base = getSqlCompletionContext(sql, cursor, options);
  const model = semantic ? buildSqlSemanticModel(sql, cursor, options) : undefined;
  const context = editorAnalysis ? new SqlCompletionAnalysisEngine().analyze({ sql, cursor, ...options, semanticCompletionEnabled: semantic }).completionContext : model ? sqlCompletionContextFromSemantic(model, base) : base;
  const columnsByTable = new Map<string, SqlCompletionColumn[]>(["a", "b", "c"].map((suffix) => [`probe_${suffix}`, ["id", `${suffix}_only`].map((name) => ({ name, table: `probe_${suffix}` }))]));
  // Match the editor metadata path: local columns come from the resolved context,
  // not every source in the global semantic model (including hidden query blocks).
  for (const table of context.referencedTables) {
    if (table.columns?.length)
      columnsByTable.set(
        table.name,
        table.columns.map((name) => ({ name, table: table.name, schema: table.schema })),
      );
  }
  const items = buildSqlCompletionItemsFromContext(context, { ...options, tables: [], columnsByTable });
  return { context, columns: items.filter((item) => item.type === "column").map((item) => item.apply ?? item.label) };
}

describe.each([false, true])("SQL completion query scopes (semantic=%s)", (semantic) => {
  it("only offers derived-table output in the outer query (#14475)", () => {
    const { context, columns } = complete("SELECT id| FROM (SELECT t1.id FROM probe_a t1 JOIN probe_b t2 ON t1.id = t2.id) sq", semantic);
    expect(context.referencedTables.map((table) => table.alias ?? table.name)).toEqual(["sq"]);
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.every((column) => column === "id" || column === "sq.id")).toBe(true);
  });

  it("keeps the current level of a multiply nested derived table", () => {
    const { context, columns } = complete("SELECT * FROM (SELECT id| FROM (SELECT a.id FROM probe_a a) inner_query) outer_query", semantic);
    expect(context.referencedTables.map((table) => table.alias ?? table.name)).toEqual(["inner_query"]);
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.every((column) => column === "id" || column === "inner_query.id")).toBe(true);
  });

  it("retains outer joins while hiding the derived table's implementation", () => {
    const { context, columns } = complete("SELECT id| FROM (SELECT a.id FROM probe_a a) sq JOIN probe_c c ON c.id = sq.id", semantic);
    expect(context.referencedTables.map((table) => table.alias ?? table.name).sort()).toEqual(["c", "sq"]);
    expect(columns).toEqual(expect.arrayContaining(["sq.id", "c.id"]));
    expect(columns).not.toContain("a.id");
  });

  it("preserves access to the outer table from a correlated subquery", () => {
    const { columns } = complete("SELECT * FROM probe_a a WHERE EXISTS (SELECT 1 FROM probe_b b WHERE a.|)", semantic);
    expect(columns).toEqual(expect.arrayContaining(["id", "a_only"]));
    expect(columns).not.toContain("b_only");
  });

  it.each(["SELECT 1, (SELECT a.|) FROM probe_a a", "SELECT COALESCE(1, (SELECT a.|)) FROM probe_a a"])("preserves correlation after an expression comma: %s", (sql) => {
    const { columns } = complete(sql, semantic);
    expect(columns).toEqual(expect.arrayContaining(["id", "a_only"]));
  });

  it("does not correlate a non-LATERAL derived table with its outer FROM", () => {
    const { context } = complete("SELECT * FROM probe_a a, (SELECT b.| FROM probe_b b) sq", semantic);
    expect(context.referencedTables.map((table) => table.alias ?? table.name)).toEqual(["b"]);
  });

  it("retains correlation in a LATERAL derived table", () => {
    const { columns } = complete("SELECT * FROM probe_a a, LATERAL (SELECT a.|) sq", semantic);
    expect(columns).toEqual(expect.arrayContaining(["id", "a_only"]));
  });

  it("keeps completion available for unresolved derived-table star output", () => {
    const { columns } = complete("SELECT id| FROM (SELECT * FROM probe_a a) sq", semantic);
    expect(columns.some((column) => column === "id" || column.endsWith(".id"))).toBe(true);
  });

  it.each(["SELECT a_only| FROM (SELECT a.a_only FROM probe_a a)", "SELECT a_only| FROM (SELECT a.a_only FROM probe_a a), probe_b b"])("keeps metadata completion before a derived-table alias is supplied: %s", (sql) => {
    const { columns } = complete(sql, semantic);
    expect(columns.some((column) => column === "a_only" || column.endsWith(".a_only"))).toBe(true);
  });

  it("keeps correlated completion while a subquery is unfinished", () => {
    const { columns } = complete("SELECT * FROM probe_a a WHERE EXISTS (SELECT 1 FROM probe_b b WHERE a.|", semantic);
    expect(columns).toEqual(expect.arrayContaining(["id", "a_only"]));
  });

  it("preserves the mutation target in a WITH UPDATE correlated query", () => {
    const { context, columns } = complete("WITH q AS (SELECT 1) UPDATE probe_a a SET id = 1 WHERE EXISTS (SELECT a.|)", semantic);
    expect(context.referencedTablesScoped).not.toBe(true);
    expect(columns).toEqual(expect.arrayContaining(["id", "a_only"]));
  });

  it("preserves quoted aliases on the visible derived table", () => {
    const { context, columns } = complete('SELECT "Result".| FROM (SELECT a.id FROM probe_a a) "Result"', semantic);
    expect(context.referencedTables.map((table) => table.alias ?? table.name)).toEqual(["Result"]);
    expect(columns).toContain("id");
  });

  it("does not borrow an alias from a sibling scalar subquery", () => {
    const { context, columns } = complete("SELECT (SELECT b.id FROM probe_b b), (SELECT c.| FROM probe_c c) FROM probe_a a", semantic);
    expect(context.referencedTables.some((table) => table.alias === "b")).toBe(false);
    expect(columns).toEqual(expect.arrayContaining(["id", "c_only"]));
    expect(columns).not.toContain("b_only");
  });

  it("resolves a shadowed alias to the innermost table", () => {
    const { columns } = complete("SELECT * FROM probe_a x WHERE EXISTS (SELECT 1 FROM probe_b x WHERE x.|)", semantic);
    expect(columns).toEqual(expect.arrayContaining(["id", "b_only"]));
    expect(columns).not.toContain("a_only");
  });

  it("retains same-named tables from different schemas in one query block", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT b_only| FROM sales.shared JOIN archive.shared ON true WHERE EXISTS (SELECT 1)");
    const options = { databaseType: "postgres", dialect: "postgres" } as const;
    const base = getSqlCompletionContext(sql, cursor, options);
    const context = semantic ? sqlCompletionContextFromSemantic(buildSqlSemanticModel(sql, cursor, options), base) : base;
    expect(context.referencedTables.map((table) => table.schema)).toEqual(["sales", "archive"]);
    const columnsByTable = new Map([
      ["sales.shared", [{ name: "a_only", table: "shared", schema: "sales" }]],
      ["archive.shared", [{ name: "b_only", table: "shared", schema: "archive" }]],
    ]);
    const items = buildSqlCompletionItemsFromContext(context, { ...options, tables: [], columnsByTable });
    expect(items.some((item) => item.type === "column" && /(?:^|\.)b_only$/.test(item.apply ?? item.label))).toBe(true);
  });

  it("keeps CTE implementation tables out of a derived-table result", () => {
    const { columns } = complete("WITH cte AS (SELECT a.id FROM probe_a a) SELECT id| FROM (SELECT id FROM cte) sq", semantic);
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.every((column) => column === "id" || column === "sq.id")).toBe(true);
  });

  it("scopes a derived-table query inside a CTE body", () => {
    const { context, columns } = complete("WITH q AS (SELECT id| FROM (SELECT a.id FROM probe_a a) sq) SELECT * FROM q", semantic);
    expect(context.referencedTables.map((table) => table.alias ?? table.name)).toEqual(["sq"]);
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.every((column) => column === "id" || column === "sq.id")).toBe(true);
  });

  it("separates the sources of UNION branches", () => {
    const { context, columns } = complete("SELECT a.| FROM probe_a a UNION ALL SELECT b.id FROM probe_b b", semantic);
    expect(context.referencedTables.map((table) => table.alias ?? table.name)).toEqual(["a"]);
    expect(columns).toEqual(expect.arrayContaining(["id", "a_only"]));
    expect(columns).not.toContain("b_only");
  });

  it("does not treat a parenthesized JOIN as a subquery scope", () => {
    const { columns } = complete("SELECT b.| FROM (probe_a a JOIN probe_b b ON a.id = b.id)", semantic);
    expect(columns).toEqual(expect.arrayContaining(["id", "b_only"]));
  });

  it("ignores query-like text in comments and string literals", () => {
    const { context, columns } = complete("SELECT id| FROM (SELECT a.id, '(SELECT * FROM probe_b b)' AS note /* (SELECT * FROM probe_c c) */ FROM probe_a a) sq", semantic);
    expect(context.referencedTables.map((table) => table.alias ?? table.name)).toEqual(["sq"]);
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.every((column) => column === "id" || column === "sq.id")).toBe(true);
  });

  it("works without database metadata for the manual reproduction query", () => {
    const { columns } = complete("SELECT id| FROM (SELECT t1.id FROM (SELECT 1 AS id) t1 JOIN (SELECT 2 AS id) t2 ON t1.id = t2.id) sq", semantic);
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.every((column) => column === "id" || column === "sq.id")).toBe(true);
  });
});

describe.each([
  { mode: "legacy", semantic: false, editorAnalysis: false },
  { mode: "semantic", semantic: true, editorAnalysis: false },
  { mode: "editor", semantic: true, editorAnalysis: true },
])("SQL completion review regressions ($mode)", ({ semantic, editorAnalysis }) => {
  it.each([
    "WITH /* note */ q AS (SELECT 1 AS id) SELECT q.| FROM q WHERE EXISTS (SELECT 1)",
    "WITH q AS /* note */ (SELECT 1 AS id) SELECT q.| FROM q WHERE EXISTS (SELECT 1)",
    "WITH -- note\n q /* name */ AS (SELECT 1 AS id) SELECT q.| FROM q WHERE EXISTS (SELECT 1)",
    "WITH q /* columns */ (/* first */ id) AS (SELECT 1) SELECT q.| FROM q WHERE EXISTS (SELECT 1)",
    "WITH q AS (SELECT 1 AS id), /* next */ r AS (SELECT * FROM q) SELECT r.| FROM r WHERE EXISTS (SELECT 1)",
    "WITH q AS (SELECT /* ) , FROM */ 1 AS id) SELECT q.| FROM q WHERE EXISTS (SELECT 1)",
  ])("reads CTE declarations through comments: %s", (sql) => {
    expect(complete(sql, semantic, editorAnalysis).columns).toEqual(["id"]);
  });

  it.each([
    "WITH q AS (SELECT $$hello from there$$ AS message) SELECT q.| FROM q WHERE EXISTS (SELECT 1)",
    "WITH q AS (SELECT $note$FROM , ) UNION WITH$note$ AS message) SELECT q.| FROM q WHERE EXISTS (SELECT 1)",
    "WITH q AS (SELECT '( FROM , UNION )' AS message) SELECT q.| FROM q WHERE EXISTS (SELECT 1)",
  ])("keeps string contents out of CTE projection boundaries: %s", (sql) => {
    expect(complete(sql, semantic, editorAnalysis).columns).toEqual(["message"]);
  });

  it.each([
    "SELECT sq.| FROM (SELECT 1 AS x /* , */, 2 AS y, 3 AS z) sq(a,b,c)",
    "SELECT sq.| FROM (SELECT 1 AS x -- ,\n, 2 AS y, 3 AS z) sq(a,b,c)",
    "SELECT sq.| FROM (SELECT $$, FROM$$ AS x, 2 AS y, 3 AS z) sq(a,b,c)",
    "WITH q AS (SELECT 1 AS x /* , */, 2 AS y, 3 AS z) SELECT q.| FROM q AS q(a,b,c) WHERE EXISTS (SELECT 1)",
    "WITH q AS (SELECT sq.* FROM (SELECT 1 AS x /* , */, 2 AS y, 3 AS z) sq(a,b,c)) SELECT q.| FROM q WHERE EXISTS (SELECT 1)",
  ])("keeps column alias positions when comments or strings contain commas: %s", (sql) => {
    expect(complete(sql, semantic, editorAnalysis).columns).toEqual(["a", "b", "c"]);
  });

  it.each(["1e3", "ARRAY[1,2]"])("does not create an alias by separating expression tokens: %s", (expression) => {
    const { columns } = complete(`WITH q AS (SELECT ${expression}, 3 AS y FROM probe_a) SELECT q.| FROM q WHERE EXISTS (SELECT 1)`, semantic, editorAnalysis);
    expect(columns).toEqual(["y"]);
  });

  it.each([
    "WITH q AS ((SELECT 1 AS first_col) UNION ALL SELECT 2 AS second_col) SELECT q.| FROM q WHERE EXISTS (SELECT 1)",
    "SELECT sq.| FROM ((SELECT 1 AS first_col) UNION ALL SELECT 2 AS second_col) sq",
    "WITH q AS (WITH c AS (SELECT 1 AS c_col) ((SELECT 1 AS first_col)) UNION ALL SELECT 2 AS second_col) SELECT q.| FROM q WHERE EXISTS (SELECT 1)",
    "SELECT sq.| FROM (WITH c AS (SELECT 1 AS c_col) (SELECT 1 AS first_col) UNION ALL SELECT 2 AS second_col) sq",
    "WITH q AS (((SELECT 1 AS first_col) UNION ALL SELECT 2 AS second_col)) SELECT q.| FROM q WHERE EXISTS (SELECT 1)",
  ])("uses the first output branch when set operands have different parentheses: %s", (sql) => {
    expect(complete(sql, semantic, editorAnalysis).columns).toEqual(["first_col"]);
  });

  it("preserves output from a ClickHouse scalar WITH binding", () => {
    const { columns } = complete("WITH q AS (WITH 1 AS n SELECT n AS id) SELECT q.| FROM q WHERE EXISTS (SELECT 1)", semantic, editorAnalysis, { databaseType: "clickhouse", dialect: "clickhouse" });
    expect(columns).toEqual(["id"]);
  });

  it("preserves output after a PostgreSQL recursive SEARCH clause", () => {
    const { columns } = complete("WITH q AS (WITH RECURSIVE c(id) AS (SELECT 1 AS id UNION ALL SELECT id+1 FROM c WHERE id<3) SEARCH DEPTH FIRST BY id SET ord SELECT id FROM c) SELECT q.| FROM q WHERE EXISTS (SELECT 1)", semantic, editorAnalysis);
    expect(columns).toEqual(["id"]);
  });

  it.each([
    ["count(*)", "count"],
    ["sum(id)", "sum"],
    ["pg_catalog.count(*)", "count"],
    ["id::integer", "id"],
    ['id::"text"', "id"],
    ["id::integer::text", "id"],
    ["CAST(id AS text)", "id"],
    ["((id))", "id"],
    ["(SELECT 1 AS x)", "x"],
    ["CAST(count(*) AS text)", "count"],
    ["count(*)::bigint", "count"],
    ["count(*) FILTER (WHERE true)", "count"],
    ["count(*) OVER ()", "count"],
    ['count(*) AS "ExactName"', "ExactName"],
  ])("retains PostgreSQL default output names in CTEs: %s", (expression, name) => {
    const { context, columns } = complete(`WITH q AS (SELECT ${expression} FROM probe_a) SELECT q.| FROM q WHERE EXISTS (SELECT 1)`, semantic, editorAnalysis);
    expect(context.referencedTables.find((table) => table.name === "q")?.columns).toEqual([name]);
    expect(columns).toHaveLength(1);
  });

  it.each(["count(*) + 1", "TRIM(' x ')"])("does not invent a name for an unresolved expression: %s", (expression) => {
    const { columns } = complete(`WITH q AS (SELECT ${expression} FROM probe_a) SELECT q.| FROM q WHERE EXISTS (SELECT 1)`, semantic, editorAnalysis);
    expect(columns).toEqual([]);
  });

  it.each([
    ["1::integer", "int4"],
    ["CAST(id OR flag AS boolean)", "bool"],
  ])("uses PostgreSQL's default output name for %s", (expression, expected) => {
    const { columns } = complete(`WITH q AS (SELECT ${expression} FROM probe_a) SELECT q.| FROM q WHERE EXISTS (SELECT 1)`, semantic, editorAnalysis);
    expect(columns).toEqual([expected]);
  });

  it.each(["TRIM(' x ') wanted", "count(*) + 1 AS wanted", "CAST(id OR flag AS boolean) wanted"])("retains explicit output aliases around unresolved expressions: %s", (expression) => {
    const { columns } = complete(`WITH q AS (SELECT ${expression} FROM probe_a) SELECT q.| FROM q WHERE EXISTS (SELECT 1)`, semantic, editorAnalysis);
    expect(columns).toEqual(["wanted"]);
  });

  it.each([
    ["WITH q AS (SELECT 1, 2 AS y) SELECT q.| FROM q AS q(a) WHERE EXISTS (SELECT 1)", ["a", "y"]],
    ["WITH q AS (SELECT 1, count(*), 3 AS y) SELECT q.| FROM q AS q(a,b) WHERE EXISTS (SELECT 1)", ["a", "b", "y"]],
    ["WITH q AS (SELECT 1, 2 AS y), r AS (SELECT * FROM q) SELECT r.| FROM r AS r(a) WHERE EXISTS (SELECT 1)", ["a", "y"]],
    ["WITH q AS (SELECT sq.* FROM (SELECT 1, 2 AS y) sq(a)) SELECT q.| FROM q WHERE EXISTS (SELECT 1)", ["a", "y"]],
    ["WITH q(a) AS (SELECT 1, 2 AS y) SELECT q.| FROM q WHERE EXISTS (SELECT 1)", ["a", "y"]],
    ["WITH q AS (SELECT 1, 2 AS y), r AS (SELECT * FROM q AS renamed(a)) SELECT r.| FROM r WHERE EXISTS (SELECT 1)", ["a", "y"]],
  ])("preserves unknown output positions before applying CTE column aliases: %s", (sql, expected) => {
    expect(complete(sql as string, semantic, editorAnalysis).columns).toEqual(expected);
  });

  it.each([
    ["WITH q(a,b) AS (SELECT * FROM pg_catalog.pg_class), r AS (SELECT s.* FROM q s(x,y)) SELECT r.| FROM r WHERE EXISTS (SELECT 1)", ["x", "y"]],
    ["WITH q(a) AS (SELECT * FROM pg_catalog.pg_class), r AS (SELECT s.* FROM q s(x)) SELECT r.| FROM r WHERE EXISTS (SELECT 1)", ["x"]],
    ["WITH q(a,b) AS (SELECT * FROM pg_catalog.pg_class), r AS (SELECT s.* FROM (SELECT * FROM q) s(x,y)) SELECT r.| FROM r WHERE EXISTS (SELECT 1)", ["x", "y"]],
    ["WITH q(a,b) AS (SELECT * FROM pg_catalog.pg_class) SELECT q.| FROM q AS q(x) WHERE EXISTS (SELECT 1)", ["x", "b"]],
    ["WITH q(a) AS (SELECT * FROM pg_catalog.pg_class), r AS (SELECT 1 AS prefix, q.* FROM q) SELECT r.| FROM r AS r(p,x) WHERE EXISTS (SELECT 1)", ["p", "x"]],
    ["WITH q(a) AS (SELECT * FROM pg_catalog.pg_class), r AS (SELECT q.*, 1 AS after_star FROM q) SELECT r.| FROM r AS r(x) WHERE EXISTS (SELECT 1)", ["x", "after_star"]],
  ])("renames known CTE prefixes while preserving unknown star widths: %s", (sql, expected) => {
    expect(complete(sql as string, semantic, editorAnalysis).columns).toEqual(expected);
  });

  it.each([
    ["WITH q AS (SELECT * FROM pg_catalog.pg_class) SELECT s.| FROM q s(x,y) WHERE EXISTS (SELECT 1)", ["x", "y"]],
    ["WITH q AS (SELECT p.*, 1 AS tail FROM probe_a p) SELECT s.| FROM q s(x,y) WHERE EXISTS (SELECT 1)", ["x", "y"]],
    ["WITH q AS (SELECT p.*, 1 AS tail FROM probe_a p) SELECT s.| FROM q s(x,y,z) WHERE EXISTS (SELECT 1)", ["x", "y", "z"]],
    ["WITH q AS (SELECT 1 AS head, p.*, 2 AS tail FROM probe_a p) SELECT s.| FROM q s(x,y,z) WHERE EXISTS (SELECT 1)", ["x", "y", "z"]],
    ["WITH q AS (SELECT 1 AS head, p.*, 2 AS tail FROM probe_a p) SELECT s.| FROM q s(x) WHERE EXISTS (SELECT 1)", ["x", "tail"]],
    ["WITH q AS (SELECT * FROM probe_a), r AS (SELECT s.* FROM q s(x,y)) SELECT r.| FROM r WHERE EXISTS (SELECT 1)", ["x", "y"]],
    ["WITH q AS (SELECT p.*, 1 AS tail FROM probe_a p), r AS (SELECT s.* FROM q s(x,y,z)) SELECT t.| FROM r t(first_name) WHERE EXISTS (SELECT 1)", ["first_name", "y", "z"]],
    ["WITH q AS (SELECT * FROM probe_a), r AS (SELECT s.* FROM (SELECT * FROM q) s(x,y)) SELECT r.| FROM r WHERE EXISTS (SELECT 1)", ["x", "y"]],
    ['WITH q AS (SELECT * FROM probe_a) SELECT s.| FROM q s("FirstName", other_name) WHERE EXISTS (SELECT 1)', ['"FirstName"', "other_name"]],
    ["WITH q(x,y,z) AS (SELECT p.*, 1 AS tail FROM probe_a p) SELECT q.| FROM q WHERE EXISTS (SELECT 1)", ["x", "y", "z"]],
    ["WITH q(first_name) AS (SELECT 1 AS head, p.*, 2 AS tail FROM probe_a p) SELECT q.| FROM q WHERE EXISTS (SELECT 1)", ["first_name", "tail"]],
  ])("retains declared column aliases across unresolved stars: %s", (sql, expected) => {
    expect(complete(sql as string, semantic, editorAnalysis).columns).toEqual(expected);
  });

  it.each([
    ["WITH q AS (SELECT p.*, 1 AS tail1, 2 AS tail2, 3 AS tail3 FROM pg_catalog.pg_class p) SELECT s.| FROM q s(x) WHERE EXISTS (SELECT 1)", ["x", "tail2", "tail3"]],
    ["WITH q AS (SELECT 0 AS head, p.*, 1 AS tail1, 2 AS tail2, 3 AS tail3 FROM pg_catalog.pg_class p) SELECT s.| FROM q s(x,y) WHERE EXISTS (SELECT 1)", ["x", "y", "tail2", "tail3"]],
    ["WITH q(x) AS (SELECT p.*, 1 AS tail1, 2 AS tail2, 3 AS tail3 FROM pg_catalog.pg_class p) SELECT q.| FROM q WHERE EXISTS (SELECT 1)", ["x", "tail2", "tail3"]],
    ["WITH q AS (SELECT p.*, 1 AS tail1, 2 AS tail2, 3 AS tail3 FROM pg_catalog.pg_class p), r AS (SELECT s.* FROM q s(x)) SELECT t.| FROM r t(y) WHERE EXISTS (SELECT 1)", ["y", "tail2", "tail3"]],
    ["WITH q AS (SELECT p.*, 1 AS tail1, 2 AS tail2, 3 AS tail3 FROM pg_catalog.pg_class p), r AS (SELECT s.*, p.*, 4 AS tail4 FROM q s(x), probe_a p) SELECT t.| FROM r t(y,z) WHERE EXISTS (SELECT 1)", ["y", "z", "tail3", "tail4"]],
  ])("retains suffix columns definitely beyond an unknown star's alias prefix: %s", (sql, expected) => {
    expect(complete(sql as string, semantic, editorAnalysis).columns).toEqual(expected);
  });

  it.each([
    "SELECT (SELECT sq.id FROM (SELECT a.|) sq) FROM probe_a a",
    "SELECT * FROM probe_a a WHERE EXISTS (SELECT 1 FROM (SELECT a.|) sq)",
    "SELECT (SELECT sq.id FROM probe_b b JOIN (SELECT a.|) sq ON true) FROM probe_a a",
    "SELECT (SELECT sq.id FROM ((SELECT a.|)) sq) FROM probe_a a",
    "SELECT (SELECT sq.id FROM (WITH q AS (SELECT a.|) SELECT * FROM q) sq) FROM probe_a a",
    "SELECT (SELECT sq.id FROM (probe_b b JOIN (SELECT a.|) sq ON true)) FROM probe_a a",
    "SELECT (SELECT * FROM (SELECT * FROM (SELECT a.|) inner_sq) outer_sq) FROM probe_a a",
  ])("preserves grandparent correlation across non-LATERAL scopes: %s", (sql) => {
    const { columns } = complete(sql, semantic, editorAnalysis);
    expect(columns).toEqual(expect.arrayContaining(["id", "a_only"]));
    expect(columns).not.toContain("b_only");
  });

  it("still excludes the immediate owner's FROM inside a non-LATERAL query", () => {
    const { context, columns } = complete("SELECT (SELECT sq.id FROM probe_b b JOIN (SELECT b.|) sq ON true) FROM probe_a a", semantic, editorAnalysis);
    expect(context.referencedTables.map((table) => table.alias ?? table.name)).toEqual(["a"]);
    expect(columns).toEqual([]);
  });

  it("does not let an inaccessible owner's alias shadow a legal grandparent alias", () => {
    const { columns } = complete("SELECT (SELECT sq.id FROM probe_b x JOIN (SELECT x.|) sq ON true) FROM probe_a x", semantic, editorAnalysis);
    expect(columns).toEqual(expect.arrayContaining(["id", "a_only"]));
    expect(columns).not.toContain("b_only");
  });

  it.each(["SELECT (SELECT sq.id FROM probe_b b JOIN (SELECT b.|) sq ON true) FROM (SELECT * FROM probe_a) a", "SELECT (SELECT sq.id FROM probe_b b JOIN (SELECT b.|) sq ON true) FROM (SELECT id FROM probe_a)"])(
    "does not restore isolated sources when a grandparent projection needs fallback: %s",
    (sql) => {
      const { context, columns } = complete(sql, semantic, editorAnalysis);
      expect(context.referencedTables.some((table) => table.alias === "b")).toBe(false);
      expect(columns).toEqual([]);
    },
  );

  it("retains other grandparent sources beside an unresolved wildcard projection", () => {
    const { columns } = complete("SELECT (SELECT sq.id FROM probe_b b JOIN (SELECT c.|) sq ON true) FROM (SELECT * FROM probe_a) a JOIN probe_c c ON true", semantic, editorAnalysis);
    expect(columns).toEqual(expect.arrayContaining(["id", "c_only"]));
    expect(columns).not.toContain("b_only");
  });

  it("does not borrow an inaccessible same-named alias's projection for a grandparent star", () => {
    const { context, columns } = complete("SELECT (SELECT sq.id FROM (SELECT 1 AS wrong) a JOIN (SELECT a.|) sq ON true) FROM (SELECT * FROM probe_c) a", semantic, editorAnalysis);
    expect(context.referencedTables.find((table) => table.alias === "a")?.columns ?? []).not.toContain("wrong");
    expect(columns).not.toContain("wrong");
  });

  it.each([
    ["WITH q AS (SELECT 1 AS MixedName) SELECT q.| FROM q WHERE EXISTS (SELECT 1)", ["mixedname"]],
    ["WITH q(ID) AS (SELECT 1) SELECT q.| FROM q WHERE EXISTS (SELECT 1)", ["id"]],
    ['WITH Q(MixedName, "ExactName") AS (SELECT 1, 2) SELECT q.| FROM Q WHERE EXISTS (SELECT 1)', ["mixedname", '"ExactName"']],
    ['WITH "Q" AS (SELECT 1 AS "MixedName") SELECT "Q".| FROM "Q" WHERE EXISTS (SELECT 1)', ['"MixedName"']],
    ["WITH q AS (SELECT CAST(1 AS integer) MixedName) SELECT q.| FROM q WHERE EXISTS (SELECT 1)", ["mixedname"]],
    ["WITH q AS (SELECT 1 AS MixedName UNION ALL SELECT 2 AS Other) SELECT q.| FROM q WHERE EXISTS (SELECT 1)", ["mixedname"]],
    ['WITH q AS (SELECT 1 AS MixedName, 2 AS "ExactName"), r AS (SELECT * FROM q) SELECT r.| FROM r WHERE EXISTS (SELECT 1)', ["mixedname", '"ExactName"']],
    ['WITH q AS (SELECT sq.* FROM (SELECT 1 AS MixedName, 2 AS "ExactName") sq) SELECT q.| FROM q WHERE EXISTS (SELECT 1)', ["mixedname", '"ExactName"']],
    ['WITH q AS (SELECT 1 AS "Mi""xed") SELECT q.| FROM q WHERE EXISTS (SELECT 1)', ['"Mi""xed"']],
    ['WITH q AS (SELECT 1 AS lower_name), "Q" AS (SELECT 2 AS upper_name), r AS (SELECT * FROM q) SELECT r.| FROM r WHERE EXISTS (SELECT 1)', ["lower_name"]],
    ['WITH q AS (SELECT 1 AS lower_name), "Q" AS (SELECT 2 AS upper_name), r AS (SELECT "Q".* FROM "Q") SELECT r.| FROM r WHERE EXISTS (SELECT 1)', ["upper_name"]],
    ['WITH q AS (SELECT 1 AS lower_name), "Q" AS (SELECT 2 AS upper_name), r AS (SELECT * FROM q JOIN "Q" ON true) SELECT r.| FROM r WHERE EXISTS (SELECT 1)', ["lower_name", "upper_name"]],
    ["WITH q AS (SELECT 1 AS MixedName), hidden AS (SELECT 2 AS hidden_name), r AS (SELECT * FROM q WHERE EXISTS (SELECT 1 FROM hidden)) SELECT r.| FROM r WHERE EXISTS (SELECT 1)", ["mixedname"]],
    ['WITH q AS (SELECT sq.* FROM (SELECT 1 AS original) sq("Renamed")) SELECT q.| FROM q WHERE EXISTS (SELECT 1)', ['"Renamed"']],
    ["WITH q AS (SELECT 1 AS MixedName), r AS (SELECT * FROM ((SELECT * FROM q)) sq) SELECT r.| FROM r WHERE EXISTS (SELECT 1)", ["mixedname"]],
    ["WITH q AS (SELECT 1 AS MixedName), r AS (SELECT * FROM ((SELECT * FROM q UNION ALL SELECT 2 AS other)) sq) SELECT r.| FROM r WHERE EXISTS (SELECT 1)", ["mixedname"]],
  ])("keeps CTE output identifier semantics: %s", (sql, expected) => {
    const { columns } = complete(sql as string, semantic, editorAnalysis);
    expect(columns.sort()).toEqual([...expected].sort());
  });

  it("resolves an escaped CTE name without losing its normalized output", () => {
    const { context, columns } = complete('WITH "Mi""xed" AS (SELECT 1 AS ValueName) SELECT "Mi""xed".| FROM "Mi""xed" WHERE EXISTS (SELECT 1)', semantic, editorAnalysis);
    expect(context.referencedTables[0].name).toBe('Mi"xed');
    expect(context.referencedTables[0].columns).toEqual(["valuename"]);
    // The semantic/editor path decodes escaped qualifier tokens; the legacy qualifier
    // scanner's existing double-quote escape limitation is outside scope resolution.
    if (semantic) expect(columns).toEqual(["valuename"]);
  });

  it("does not expand a schema-qualified table's star using a same-named CTE", () => {
    const { context, columns } = complete("WITH q AS (SELECT 1 AS cte_only), r AS (SELECT * FROM public.q) SELECT r.| FROM r WHERE EXISTS (SELECT 1)", semantic, editorAnalysis);
    expect(context.referencedTables.find((table) => table.name === "r")?.columns ?? []).not.toContain("cte_only");
    expect(columns).not.toContain("cte_only");
  });

  it.each([
    ["oracle", "MIXEDNAME"],
    ["mysql", "MixedName"],
  ] as const)("uses %s identifier rules for CTE output", (databaseType, expected) => {
    const { context } = complete("WITH Q AS (SELECT 1 AS MixedName) SELECT Q.| FROM Q WHERE EXISTS (SELECT 1)", semantic, editorAnalysis, { databaseType });
    expect(context.referencedTables[0].columns).toEqual([expected]);
  });

  it.each([
    "SELECT wanted| FROM (SELECT CAST(a.id AS integer) wanted FROM probe_a a) sq",
    "SELECT wanted| FROM (SELECT (SELECT 1 AS inner_alias) wanted FROM probe_a a) sq",
    "SELECT wanted| FROM (SELECT 1 AS wanted UNION ALL SELECT 2 AS other) sq",
    "SELECT wanted| FROM (SELECT 1 AS wanted EXCEPT SELECT 2 AS other) sq",
    "SELECT wanted| FROM (SELECT a.id AS wanted FROM probe_a a) sq",
  ])("retains the derived table's output name: %s", (sql) => {
    const { context, columns } = complete(sql, semantic, editorAnalysis);
    expect(context.referencedTables.map((table) => table.alias ?? table.name)).toEqual(["sq"]);
    expect(columns).toEqual(["wanted"]);
  });

  it("honors an explicit derived-table column alias list", () => {
    const { columns } = complete("SELECT renamed| FROM (SELECT CAST(a.id AS integer) original FROM probe_a a) sq(renamed)", semantic, editorAnalysis);
    expect(columns).toEqual(["renamed"]);
  });

  it("retains unrenamed columns after a partial column alias list", () => {
    const { context, columns } = complete("SELECT remaining_value| FROM (SELECT a.id AS first, CAST(a.a_only AS text) remaining_value FROM probe_a a) sq(renamed)", semantic, editorAnalysis);
    expect(context.referencedTables[0].columns).toEqual(["renamed", "remaining_value"]);
    expect(columns).toEqual(["remaining_value"]);
  });

  it("folds unquoted PostgreSQL output aliases", () => {
    const { context, columns } = complete("SELECT mixedname| FROM (SELECT CAST(a.id AS integer) MixedName FROM probe_a a) sq", semantic, editorAnalysis);
    expect(context.referencedTables[0].columns).toEqual(["mixedname"]);
    expect(columns).toEqual(["mixedname"]);
  });

  it("preserves quoted PostgreSQL output aliases", () => {
    const { context, columns } = complete('SELECT "MixedName"| FROM (SELECT CAST(a.id AS integer) "MixedName" FROM probe_a a) sq', semantic, editorAnalysis);
    expect(context.referencedTables[0].columns).toEqual(["MixedName"]);
    expect(columns).toEqual(['"MixedName"']);
  });

  it("resolves a reused derived-table alias in its own query block", () => {
    const { context, columns } = complete("SELECT * FROM (SELECT inner_name| AS outer_name FROM (SELECT 1 AS inner_name) sq) sq", semantic, editorAnalysis);
    expect(context.referencedTables.map((table) => table.alias ?? table.name)).toEqual(["sq"]);
    expect(columns).toEqual(["inner_name"]);
  });

  it.each(["SELECT (WITH q AS (SELECT a.|) SELECT * FROM q) FROM probe_a a", "SELECT * FROM probe_a a WHERE EXISTS (WITH q AS (SELECT a.|) SELECT * FROM q)", "SELECT * FROM probe_a a, LATERAL (WITH q AS (SELECT a.|) SELECT * FROM q) sq"])(
    "allows a nested CTE to correlate with its outer query: %s",
    (sql) => {
      const { columns } = complete(sql, semantic, editorAnalysis);
      expect(columns).toEqual(expect.arrayContaining(["id", "a_only"]));
    },
  );

  it.each(["SELECT * FROM probe_a a, (WITH q AS (SELECT b.| FROM probe_b b) SELECT * FROM q) sq", "SELECT * FROM probe_a a JOIN (WITH q AS (SELECT b.| FROM probe_b b) SELECT * FROM q) sq ON true"])("keeps a nested CTE inside a non-LATERAL derived table isolated: %s", (sql) => {
    const { context, columns } = complete(sql, semantic, editorAnalysis);
    expect(context.referencedTables.map((table) => table.alias ?? table.name)).toEqual(["b"]);
    expect(columns).toEqual(expect.arrayContaining(["id", "b_only"]));
  });

  it("does not expose the following main query's FROM inside its CTE", () => {
    const { context, columns } = complete("SELECT (WITH q AS (SELECT a.|) SELECT * FROM q JOIN probe_b b ON true) FROM probe_a a", semantic, editorAnalysis);
    expect(context.referencedTables.some((table) => table.alias === "b")).toBe(false);
    expect(columns).toEqual(expect.arrayContaining(["id", "a_only"]));
  });

  it("preserves correlation through parentheses that group a JOIN", () => {
    const { columns } = complete("SELECT * FROM (probe_a a JOIN probe_b b ON b.id = (SELECT a.|))", semantic, editorAnalysis);
    expect(columns).toEqual(expect.arrayContaining(["id", "a_only"]));
  });
});

describe.each([
  { mode: "legacy", semantic: false, editorAnalysis: false },
  { mode: "semantic", semantic: true, editorAnalysis: false },
  { mode: "editor", semantic: true, editorAnalysis: true },
])("SQL completion aliased JOIN scopes ($mode)", ({ semantic, editorAnalysis }) => {
  it.each([
    "SELECT * FROM (probe_a a JOIN probe_b b ON b.| = (SELECT 1)) ab",
    "SELECT * FROM (probe_a a JOIN probe_b b ON b.id = (SELECT b.|)) ab",
    "SELECT * FROM (probe_a a JOIN probe_b b ON EXISTS (SELECT b.|)) ab",
    "SELECT * FROM probe_c c JOIN (probe_a a JOIN probe_b b ON b.id = (SELECT b.|)) ab ON true",
    "SELECT * FROM ((probe_a a JOIN probe_b b ON b.id = (SELECT b.|)) inner_grp JOIN probe_c c ON true) outer_grp",
  ])("retains inner JOIN sources inside their aliased group: %s", (sql) => {
    const { columns } = complete(sql, semantic, editorAnalysis);
    expect(columns).toEqual(expect.arrayContaining(["id", "b_only"]));
    expect(columns).not.toContain("c_only");
  });

  it.each(["SELECT * FROM (probe_c b JOIN (probe_a a JOIN probe_b b ON b.id = (SELECT b.|)) inner_grp ON true) outer_grp", "SELECT * FROM probe_c b WHERE EXISTS (SELECT 1 FROM (probe_a a JOIN probe_b b ON b.id = (SELECT b.|)) ab)"])(
    "lets the innermost JOIN source shadow an outer alias: %s",
    (sql) => {
      const { columns } = complete(sql, semantic, editorAnalysis);
      expect(columns).toEqual(expect.arrayContaining(["id", "b_only"]));
      expect(columns).not.toContain("c_only");
    },
  );

  it.each([
    "SELECT b.| FROM (probe_a a JOIN probe_b b ON true) ab WHERE EXISTS (SELECT 1)",
    "SELECT * FROM (probe_a a JOIN probe_b b ON ab.| = (SELECT 1)) ab",
    "SELECT * FROM (probe_a a JOIN (SELECT a.|) sq ON true) ab",
    "SELECT * FROM (probe_a a JOIN LATERAL (SELECT sq.|) sq ON true) ab",
    "SELECT * FROM (SELECT sq.| FROM probe_a a) sq",
  ])("does not expose aliases outside their legal JOIN or derived-table scope: %s", (sql) => {
    expect(complete(sql, semantic, editorAnalysis).columns).toEqual([]);
  });

  it("allows a LATERAL query to reference a preceding source in its JOIN group", () => {
    const { columns } = complete("SELECT * FROM (probe_a a JOIN LATERAL (SELECT a.|) sq ON true) ab", semantic, editorAnalysis);
    expect(columns).toEqual(expect.arrayContaining(["id", "a_only"]));
  });

  it("retains grandparent correlation across a non-LATERAL query inside a JOIN group", () => {
    const { columns } = complete("SELECT (SELECT ab.result FROM (probe_b b JOIN (SELECT a.| AS result) sq ON true) ab) FROM probe_a a", semantic, editorAnalysis);
    expect(columns).toEqual(expect.arrayContaining(["id", "a_only"]));
    expect(columns).not.toContain("b_only");
  });
});

describe.each([
  { mode: "legacy", semantic: false, editorAnalysis: false },
  { mode: "semantic", semantic: true, editorAnalysis: false },
  { mode: "editor", semantic: true, editorAnalysis: true },
])("SQL completion JOIN group outputs ($mode)", ({ semantic, editorAnalysis }) => {
  it.each([
    ["SELECT ab.| FROM (probe_a a JOIN probe_b b ON b.id = (SELECT 1 AS fake)) ab(a_id,a_only,b_id,b_only)", ["a_id", "a_only", "b_id", "b_only"]],
    ["SELECT ab.| FROM (probe_a a JOIN probe_b b ON a.id = (SELECT 1 AS fake_a) AND b.id = (SELECT 1 AS fake_b)) ab(a_id,a_only,b_id,b_only)", ["a_id", "a_only", "b_id", "b_only"]],
    ["SELECT ab.| FROM (probe_a a JOIN probe_b b ON true) ab(a_id,a_only,b_id,b_only) WHERE EXISTS (SELECT 1 AS fake)", ["a_id", "a_only", "b_id", "b_only"]],
    ["SELECT outer_grp.| FROM ((probe_a a JOIN probe_b b ON b.id = (SELECT 1 AS fake)) inner_grp JOIN probe_c c ON true) outer_grp(a_id,a_only,b_id,b_only,c_id,c_only)", ["a_id", "a_only", "b_id", "b_only", "c_id", "c_only"]],
    ["SELECT ab.| FROM ((SELECT 1 AS x) a JOIN (SELECT 1 AS y) b ON a.x = b.y) ab(a_id,b_id)", ["a_id", "b_id"]],
  ] as const)("retains every explicit JOIN group output alias: %s", (sql, expected) => {
    const { columns } = complete(sql, semantic, editorAnalysis);
    expect([...columns].sort()).toEqual([...expected].sort());
  });

  it.each([
    "SELECT ab.| FROM (probe_a a JOIN probe_b b ON b.id = (SELECT 1 AS fake)) ab",
    "SELECT outer_grp.| FROM ((probe_a a JOIN probe_b b ON b.id = (SELECT 1 AS fake)) inner_grp JOIN probe_c c ON true) outer_grp",
    "SELECT ab.| FROM (probe_a a JOIN probe_b b ON true) ab WHERE EXISTS (SELECT 1 AS fake)",
  ])("does not use a scalar subquery's output as a JOIN group column: %s", (sql) => {
    expect(complete(sql, semantic, editorAnalysis).columns).not.toContain("fake");
  });

  it.each(["SELECT sq.| FROM ((SELECT 1 AS wanted)) sq", "SELECT sq.| FROM (((SELECT 1 AS wanted))) sq", "SELECT sq.| FROM ((SELECT (SELECT 1 AS fake) AS wanted)) sq"])("continues to read actual query output through parentheses: %s", (sql) => {
    expect(complete(sql, semantic, editorAnalysis).columns).toEqual(["wanted"]);
  });

  it("retains JOIN members inside ON while rejecting its outer alias", () => {
    const { columns } = complete("SELECT * FROM (probe_a a JOIN probe_b b ON b.id = (SELECT b.|)) ab(a_id,a_only,b_id,b_only)", semantic, editorAnalysis);
    expect(columns).toEqual(expect.arrayContaining(["id", "b_only"]));
    expect(columns).not.toContain("b_id");
  });
});

describe.each([
  { mode: "legacy", semantic: false, editorAnalysis: false },
  { mode: "semantic", semantic: true, editorAnalysis: false },
  { mode: "editor", semantic: true, editorAnalysis: true },
])("SQL completion propagated JOIN group outputs ($mode)", ({ semantic, editorAnalysis }) => {
  it.each([
    "WITH q AS (SELECT * FROM (probe_a a JOIN probe_b b ON EXISTS (SELECT 1 AS fake)) ab) SELECT q.| FROM q WHERE EXISTS (SELECT 1)",
    "WITH q AS (SELECT ab.* FROM (probe_a a JOIN probe_b b ON EXISTS (SELECT 1 AS fake)) ab) SELECT q.| FROM q WHERE EXISTS (SELECT 1)",
    "WITH q AS (SELECT s.* FROM (SELECT ab.* FROM (probe_a a JOIN probe_b b ON EXISTS (SELECT 1 AS fake)) ab) s) SELECT q.| FROM q WHERE EXISTS (SELECT 1)",
  ])("does not propagate an ON subquery's column through a star: %s", (sql) => {
    expect(complete(sql, semantic, editorAnalysis).columns).not.toContain("fake");
  });

  it.each([
    "WITH q AS (SELECT * FROM (probe_a a JOIN probe_b b ON EXISTS (SELECT 1 AS fake)) ab(a_id,a_only,b_id,b_only)) SELECT q.| FROM q WHERE EXISTS (SELECT 1)",
    "WITH q AS (SELECT ab.* FROM (probe_a a JOIN probe_b b ON EXISTS (SELECT 1 AS fake)) ab(a_id,a_only,b_id,b_only)) SELECT q.| FROM q WHERE EXISTS (SELECT 1)",
    "WITH q AS (SELECT s.* FROM (SELECT ab.* FROM (probe_a a JOIN probe_b b ON EXISTS (SELECT 1 AS fake)) ab(a_id,a_only,b_id,b_only)) s) SELECT q.| FROM q WHERE EXISTS (SELECT 1)",
  ])("propagates every declared JOIN group column through a star: %s", (sql) => {
    const { columns } = complete(sql, semantic, editorAnalysis);
    expect([...columns].sort()).toEqual(["a_id", "a_only", "b_id", "b_only"].sort());
  });

  it("propagates a genuine derived-table projection through extra parentheses", () => {
    const { columns } = complete("WITH q AS (SELECT sq.* FROM ((SELECT 1 AS wanted)) sq) SELECT q.| FROM q WHERE EXISTS (SELECT 1)", semantic, editorAnalysis);
    expect(columns).toEqual(["wanted"]);
  });
});

describe("PG default name compatibility", () => {
  describe.each([
    { mode: "legacy", semantic: false, editorAnalysis: false },
    { mode: "semantic", semantic: true, editorAnalysis: false },
    { mode: "editor", semantic: true, editorAnalysis: true },
  ])("$mode", ({ semantic, editorAnalysis }) => {
    it.each([
      ["CAST('x' AS text)", "text"],
      ["'x'::text", "text"],
      ["CAST(1 AS numeric)", "numeric"],
      ["CAST(1+1 AS numeric)", "numeric"],
      ["CAST(1 AS varchar(10))", "varchar"],
      ["1::integer", "int4"],
      ["1::smallint", "int2"],
      ["1::bigint", "int8"],
      ["1::real", "float4"],
      ["1::double precision", "float8"],
      ["1::float(12)", "float4"],
      ["1::float(30)", "float8"],
      ["1::decimal", "numeric"],
      ["CAST(false AS boolean)", "bool"],
      ["'x'::character(2)", "bpchar"],
      ["'x'::character varying(2)", "varchar"],
      ["'2000-01-01'::timestamp(2) with time zone", "timestamptz"],
      ["'12:00'::time without time zone", "time"],
      ["'{}'::integer[]", "int4"],
      ["'x'::pg_catalog.\"char\"", "char"],
      ["CAST(CAST(1 AS integer) AS text)", "text"],
      ["1::integer::text", "text"],
      ["id::integer::text", "id"],
      ["CAST(count(*) AS text)", "count"],
      ["CAST((SELECT 1) AS text)", "?column?"],
      ["CAST((SELECT 1::integer) AS text)", "int4"],
      ["CAST((SELECT 1 AS named) AS text)", "named"],
      ["((SELECT 1 AS first_col) UNION SELECT 1)", "first_col"],
      ["((SELECT 1 AS first_col) UNION SELECT 1 AS second_col)", "first_col"],
      ["CAST(NOT(false) AS boolean)", "bool"],
      ["CAST((id + 1) AS integer)", "int4"],
      ["id::double precision wanted", "wanted"],
      ['count(*)::integer "Wanted"', "Wanted"],
      ["1e-3::float", "float8"],
      ["1e+3::numeric", "numeric"],
      ["CAST((1+(SELECT 1 AS fake)) AS integer)", "int4"],
      ["(abs((SELECT 1 AS fake)))", "abs"],
      ["'1 year'::interval year to month", "interval"],
      ['CAST(1 AS "CustomType")', "CustomType"],
      ["CAST(1 AS public.integer)", "integer"],
      ["CAST(1 AS constructor)", "constructor"],
      ["CAST(1 AS __proto__)", "__proto__"],
    ])("matches PostgreSQL output naming for %s", (expression, name) => {
      const { context, columns } = complete(`WITH q AS (SELECT ${expression} FROM probe_a) SELECT q.| FROM q WHERE EXISTS (SELECT 1)`, semantic, editorAnalysis);
      expect(context.referencedTables.find((table) => table.name === "q")?.columns).toEqual([name]);
      expect(columns).toHaveLength(1);
    });

    it.each(["NOT(false)", "id + id::integer", "count(*) + 1::integer", "-1::integer", "(1+(SELECT 1 AS fake))", "(((SELECT 1 AS fake))+1)"])("does not mistake operators for named functions or whole-expression casts: %s", (expression) => {
      expect(complete(`WITH q AS (SELECT ${expression} FROM probe_a) SELECT q.| FROM q WHERE EXISTS (SELECT 1)`, semantic, editorAnalysis).columns).toEqual([]);
    });
  });
});
