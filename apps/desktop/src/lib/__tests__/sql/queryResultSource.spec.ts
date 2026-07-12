import { describe, expect, it } from "vitest";
import { queryResultSourceLabel } from "@/lib/sql/queryResultSource";

describe("queryResultSourceLabel", () => {
  it("uses the current database for an unqualified table", () => {
    expect(queryResultSourceLabel("SELECT * FROM users", { database: "app", databaseType: "mysql" })).toBe("app.users");
  });

  it("prefers the final explicit qualifier", () => {
    expect(queryResultSourceLabel("SELECT * FROM analytics.events", { database: "app", databaseType: "mysql" })).toBe("analytics.events");
    expect(queryResultSourceLabel("SELECT * FROM [ServerOne].[AppDb].[dbo].[Users]", { database: "fallback", databaseType: "sqlserver" })).toBe("dbo.Users");
  });

  it("preserves quoted identifier names", () => {
    expect(queryResultSourceLabel('SELECT * FROM "Sales"."Orders"', { database: "app", databaseType: "postgres" })).toBe("Sales.Orders");
    expect(queryResultSourceLabel("SELECT * FROM HR.EMPLOYEES", { database: "fallback", databaseType: "oracle" })).toBe("HR.EMPLOYEES");
  });

  it("labels aggregate joins with the first outer physical table", () => {
    const sql = `SELECT
      g.group_name AS GROUP_NAME,
      COUNT(*) AS USER_COUNT,
      SUM(CASE WHEN u.status = 1 THEN 1 ELSE 0 END) AS ACTIVE_USER_COUNT
    FROM groups g
    JOIN group_users gu ON gu.group_id = g.id
    JOIN users u ON u.id = gu.user_id
    GROUP BY g.id, g.group_name`;

    expect(queryResultSourceLabel(sql, { database: "aaa", databaseType: "mysql" })).toBe("aaa.groups");
  });

  it("prefers mutation targets over other table sources", () => {
    expect(queryResultSourceLabel("UPDATE users SET active = true FROM audit_events ae WHERE ae.user_id = users.id RETURNING users.id", { database: "app", databaseType: "postgres" })).toBe("app.users");
    expect(queryResultSourceLabel("INSERT INTO audit.events (id) VALUES (1) RETURNING id", { database: "app", databaseType: "postgres" })).toBe("audit.events");
    expect(queryResultSourceLabel("DELETE FROM users WHERE id = 1 RETURNING id", { database: "app", databaseType: "postgres" })).toBe("app.users");
  });

  it("ignores non-physical outer sources", () => {
    expect(queryResultSourceLabel("WITH recent AS (SELECT * FROM orders) SELECT * FROM recent", { database: "app", databaseType: "postgres" })).toBeUndefined();
    expect(queryResultSourceLabel("SELECT * FROM (SELECT * FROM users) nested", { database: "app", databaseType: "mysql" })).toBeUndefined();
    expect(queryResultSourceLabel("SELECT * FROM read_csv('users.csv') csv", { database: "main", databaseType: "duckdb" })).toBeUndefined();
    expect(queryResultSourceLabel("SELECT 1", { database: "app", databaseType: "mysql" })).toBeUndefined();
  });
});
