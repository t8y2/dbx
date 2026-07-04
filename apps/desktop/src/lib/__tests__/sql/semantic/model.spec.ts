import { describe, expect, it } from "vitest";
import { sqlSemanticCompletionScope, sqlSemanticLocalColumnsByTable, sqlSemanticProjectionAliasColumns } from "@/lib/sql/semantic/completion";
import { SQL_SEMANTIC_BASELINE_FIXTURES, sqlFixtureCursor } from "@/lib/sql/semantic/fixtures";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";

describe("sqlSemanticModel baseline fixtures", () => {
  for (const fixture of SQL_SEMANTIC_BASELINE_FIXTURES) {
    it(fixture.name, () => {
      const { sql, cursor } = sqlFixtureCursor(fixture.sql);
      const model = buildSqlSemanticModel(sql, cursor, { databaseType: fixture.databaseType });
      const scope = sqlSemanticCompletionScope(model);

      expect(model.statement.kind).toBe(fixture.expected.statementKind);
      expect(model.cursorIntent.kind).toBe(fixture.expected.cursorKind);
      expect(scope.kind).toBe(fixture.expected.completionScope);
      expect(model.cursorIntent.prefix).toBe(fixture.expected.prefix);
      expect(model.cursorIntent.qualifierParts).toEqual(fixture.expected.qualifierParts ?? []);
      expect(model.cursorIntent.confidence).toBe(fixture.expected.confidence);

      for (const expectedSource of fixture.expected.rowSources ?? []) {
        const expectedObject = Object.fromEntries(Object.entries(expectedSource).filter(([, value]) => value !== undefined));
        expect(model.rowSources).toEqual(expect.arrayContaining([expect.objectContaining(expectedObject)]));
      }

      if (fixture.expected.completionLabels) {
        const labels = [...sqlSemanticLocalColumnsByTable(model).values()].flat().map((column) => column.name);
        expect(labels).toEqual(expect.arrayContaining(fixture.expected.completionLabels));
      }
    });
  }

  it("does not mix row sources from inactive statements", () => {
    const { sql, cursor } = sqlFixtureCursor("select * from users u; select * from orders o where o.|");
    const model = buildSqlSemanticModel(sql, cursor);

    expect(model.rowSources.some((source) => source.name === "orders")).toBe(true);
    expect(model.rowSources.some((source) => source.name === "users")).toBe(false);
  });

  it("does not expose CTE body tables as outer query row sources", () => {
    const { sql, cursor } = sqlFixtureCursor("WITH recent_orders AS (SELECT id FROM orders) SELECT * FROM recent_orders ro WHERE ro.|");
    const model = buildSqlSemanticModel(sql, cursor);

    expect(model.rowSources.some((source) => source.name === "recent_orders")).toBe(true);
    expect(model.rowSources.some((source) => source.name === "orders")).toBe(false);
  });

  it("does not expose subquery body tables as outer query row sources", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT * FROM (SELECT id FROM users) sq WHERE sq.|");
    const model = buildSqlSemanticModel(sql, cursor);

    expect(model.rowSources).toEqual(expect.arrayContaining([expect.objectContaining({ name: "sq", kind: "subquery" })]));
    expect(model.rowSources.some((source) => source.name === "users")).toBe(false);
  });

  it("suppresses completion inside string literals without metadata scope", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT 'u.|' FROM users");
    const model = buildSqlSemanticModel(sql, cursor);
    const scope = sqlSemanticCompletionScope(model);

    expect(model.cursorIntent.kind).toBe("suppressed");
    expect(scope.useRemoteMetadata).toBe(false);
  });

  it("classifies table references after comma-separated table lists", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT * FROM users u, ord|");
    const model = buildSqlSemanticModel(sql, cursor);
    const scope = sqlSemanticCompletionScope(model);

    expect(model.cursorIntent.kind).toBe("table");
    expect(model.cursorIntent.prefix).toBe("ord");
    expect(scope.kind).toBe("table");
  });

  it("classifies alias-qualified star with replacement range", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT u.*| FROM users u");
    const model = buildSqlSemanticModel(sql, cursor);

    expect(model.cursorIntent.kind).toBe("star");
    expect(model.cursorIntent.prefix).toBe("*");
    expect(model.cursorIntent.qualifierParts).toEqual(["u"]);
    expect(sql.slice(model.cursorIntent.replacementRange.start, model.cursorIntent.replacementRange.end)).toBe("*");
  });

  it("returns low-confidence keyword fallback for unknown SQL", () => {
    const { sql, cursor } = sqlFixtureCursor("explain analyze |");
    const model = buildSqlSemanticModel(sql, cursor);
    const scope = sqlSemanticCompletionScope(model);

    expect(model.cursorIntent.kind).toBe("keyword");
    expect(model.cursorIntent.confidence).toBe("low");
    expect(scope.useRemoteMetadata).toBe(false);
  });

  it("exposes PostgreSQL projection aliases in ORDER BY but not WHERE", () => {
    const orderBy = sqlFixtureCursor("select total_amount as total from orders order by to|");
    const where = sqlFixtureCursor("select total_amount as total from orders where to|");

    expect(sqlSemanticProjectionAliasColumns(buildSqlSemanticModel(orderBy.sql, orderBy.cursor, { databaseType: "postgres" })).map((column) => column.name)).toContain("total");
    expect(sqlSemanticProjectionAliasColumns(buildSqlSemanticModel(where.sql, where.cursor, { databaseType: "postgres" })).map((column) => column.name)).not.toContain("total");
  });

  it("exposes MySQL projection aliases in GROUP BY and HAVING", () => {
    const groupBy = sqlFixtureCursor("select total_amount as total from orders group by to|");
    const having = sqlFixtureCursor("select total_amount as total from orders having to|");

    expect(sqlSemanticProjectionAliasColumns(buildSqlSemanticModel(groupBy.sql, groupBy.cursor, { databaseType: "mysql" })).map((column) => column.name)).toContain("total");
    expect(sqlSemanticProjectionAliasColumns(buildSqlSemanticModel(having.sql, having.cursor, { databaseType: "mysql" })).map((column) => column.name)).toContain("total");
  });

  it("keeps dialect-specific identifier normalization and qualifier scopes", () => {
    const sqlServer = sqlFixtureCursor("SELECT * FROM [dbo].[Users] u WHERE u.|");
    const postgres = sqlFixtureCursor('SELECT total AS "Order Total" FROM "Sales"."Orders" o ORDER BY "Order|');
    const mysql = sqlFixtureCursor("SELECT * FROM `analytics`.`events` e WHERE e.|");
    const sqlite = sqlFixtureCursor("SELECT * FROM main.users u WHERE u.|");

    expect(buildSqlSemanticModel(sqlServer.sql, sqlServer.cursor, { databaseType: "sqlserver" }).rowSources[0]).toEqual(expect.objectContaining({ name: "Users", qualifierParts: ["dbo"], alias: "u" }));
    expect(sqlSemanticProjectionAliasColumns(buildSqlSemanticModel(postgres.sql, postgres.cursor, { databaseType: "postgres" })).map((column) => column.name)).toContain("Order Total");
    expect(buildSqlSemanticModel(mysql.sql, mysql.cursor, { databaseType: "mysql" }).rowSources[0]).toEqual(expect.objectContaining({ name: "events", qualifierParts: ["analytics"], alias: "e" }));
    expect(buildSqlSemanticModel(sqlite.sql, sqlite.cursor, { databaseType: "sqlite" }).rowSources[0]).toEqual(expect.objectContaining({ name: "users", qualifierParts: ["main"], alias: "u" }));
  });

  it("covers SQL Server case-insensitive bracket and multi-part qualifier contexts", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT * FROM [ServerOne].[AppDb].[dbo].[Users] U WHERE u.na|");
    const model = buildSqlSemanticModel(sql, cursor, { databaseType: "sqlserver" });

    expect(model.rowSources[0]).toEqual(expect.objectContaining({ name: "Users", qualifierParts: ["ServerOne", "AppDb", "dbo"], alias: "U" }));
    expect(model.cursorIntent.kind).toBe("alias_column");
    expect(model.cursorIntent.qualifierParts).toEqual(["u"]);
  });

  it("covers PostgreSQL lower-case folding with CTEs and ORDER BY projection aliases", () => {
    const { sql, cursor } = sqlFixtureCursor("WITH RecentOrders AS (SELECT id, total FROM orders) SELECT total AS total_alias FROM RecentOrders ro ORDER BY total_|");
    const model = buildSqlSemanticModel(sql, cursor, { databaseType: "postgres" });

    expect(model.rowSources).toEqual(expect.arrayContaining([expect.objectContaining({ name: "recentorders", alias: "ro", columns: ["id", "total"] })]));
    expect(sqlSemanticProjectionAliasColumns(model).map((column) => column.name)).toContain("total_alias");
  });

  it("covers MySQL database-qualified backticks and projection alias visibility", () => {
    const groupBy = sqlFixtureCursor("SELECT amount AS total FROM `analytics`.`events` e GROUP BY to|");
    const where = sqlFixtureCursor("SELECT amount AS total FROM `analytics`.`events` e WHERE to|");

    expect(buildSqlSemanticModel(groupBy.sql, groupBy.cursor, { databaseType: "mysql" }).rowSources[0]).toEqual(expect.objectContaining({ name: "events", qualifierParts: ["analytics"], alias: "e" }));
    expect(sqlSemanticProjectionAliasColumns(buildSqlSemanticModel(groupBy.sql, groupBy.cursor, { databaseType: "mysql" })).map((column) => column.name)).toContain("total");
    expect(sqlSemanticProjectionAliasColumns(buildSqlSemanticModel(where.sql, where.cursor, { databaseType: "mysql" })).map((column) => column.name)).not.toContain("total");
  });

  it("covers SQLite and DuckDB schema-light local row-source behavior", () => {
    const sqlite = sqlFixtureCursor("SELECT * FROM main.users u WHERE u.|");
    const duckdb = sqlFixtureCursor("SELECT * FROM read_csv('users.csv') csv WHERE csv.|");

    expect(sqlSemanticCompletionScope(buildSqlSemanticModel(sqlite.sql, sqlite.cursor, { databaseType: "sqlite" })).useRemoteMetadata).toBe(true);
    expect(buildSqlSemanticModel(duckdb.sql, duckdb.cursor, { databaseType: "duckdb" }).rowSources[0]).toEqual(expect.objectContaining({ kind: "table_function", name: "csv", alias: "csv" }));
  });
});
