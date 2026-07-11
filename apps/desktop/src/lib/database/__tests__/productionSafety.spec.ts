import { describe, expect, it } from "vitest";
import { assessProductionSql, isProductionMutation, productionContextForDatabase } from "../productionSafety";
import type { ConnectionConfig } from "@/types/database";

function connection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "conn-1",
    name: "Operations",
    db_type: "mysql",
    host: "db.internal",
    port: 3306,
    username: "readonly",
    password: "",
    production_databases: ["prod_app"],
    ...overrides,
  };
}

describe("production SQL safety", () => {
  it("marks an explicitly production connection regardless of database", () => {
    expect(productionContextForDatabase(connection({ is_production: true }), "scratch").active).toBe(true);
  });

  it("marks only configured production databases for multi-database connections", () => {
    expect(productionContextForDatabase(connection(), "PROD_APP").active).toBe(true);
    expect(productionContextForDatabase(connection(), "staging").active).toBe(false);
  });

  it("detects a write after a USE production switch despite comments", () => {
    const assessment = assessProductionSql("-- install\nUSE `prod_app`; /* migration */ DELETE FROM users", connection(), "staging");
    expect(assessment).toMatchObject({ active: true, isMutation: true, databases: ["prod_app"] });
  });

  it("detects qualified production targets in multi-statement SQL", () => {
    const assessment = assessProductionSql("SELECT ';' AS literal; DELETE FROM `prod_app`.`orders`; UPDATE staging.users SET active = 1", connection(), "staging");
    expect(assessment).toMatchObject({ active: true, isMutation: true, databases: ["prod_app"] });
  });

  it("detects production database DDL without a selected production database", () => {
    expect(assessProductionSql("DROP DATABASE IF EXISTS prod_app", connection(), "staging")).toMatchObject({ active: true, isMutation: true, databases: ["prod_app"] });
  });

  it("detects production writes hidden behind parser-sensitive SQL forms", () => {
    for (const sql of ["EXPLAIN ANALYZE DELETE FROM prod_app.users WHERE id = 1", "/*! DELETE FROM prod_app.users WHERE id = 1 */", "COPY prod_app.users FROM '/tmp/users.csv'", "SELECT * INTO prod_app.backup_users FROM users", "SELECT * FROM prod_app.users INTO OUTFILE '/tmp/users.csv'"]) {
      expect(assessProductionSql(sql, connection(), "staging")).toMatchObject({ active: true, isMutation: true, databases: ["prod_app"] });
    }
  });

  it("treats unrecognized SQL as a production mutation until proven read-only", () => {
    expect(isProductionMutation("MAINTAIN UNKNOWN THING")).toBe(true);
    expect(assessProductionSql("MAINTAIN UNKNOWN THING", connection(), "prod_app")).toMatchObject({ active: true, isMutation: true });
  });

  it("does not require a production confirmation for reads", () => {
    expect(assessProductionSql("SELECT * FROM prod_app.orders", connection(), "staging")).toMatchObject({ active: false, isMutation: false });
  });
});
