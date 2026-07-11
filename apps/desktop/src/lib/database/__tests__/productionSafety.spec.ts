import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assessProductionSql, isProductionMutation, productionContextForDatabase } from "../productionSafety";
import type { ConnectionConfig, DatabaseType } from "@/types/database";

interface ProductionSafetyCorpusCase {
  name: string;
  dialect: DatabaseType;
  productionDatabases: string[];
  activeDatabase: string;
  sql: string;
  active: boolean;
  isMutation: boolean;
  databases: string[];
}

const productionSafetyCorpus = JSON.parse(readFileSync(new URL("../../../../../../tests/fixtures/production-safety-corpus.json", import.meta.url), "utf8")) as ProductionSafetyCorpusCase[];

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

  it("matches the shared SQL target safety corpus", () => {
    for (const corpusCase of productionSafetyCorpus) {
      const assessment = assessProductionSql(
        corpusCase.sql,
        connection({
          db_type: corpusCase.dialect,
          production_databases: corpusCase.productionDatabases,
        }),
        corpusCase.activeDatabase,
      );
      expect(
        {
          active: assessment.active,
          isMutation: assessment.isMutation,
          databases: assessment.databases,
        },
        corpusCase.name,
      ).toEqual({
        active: corpusCase.active,
        isMutation: corpusCase.isMutation,
        databases: corpusCase.databases,
      });
    }
  });

  it("detects qualified procedure calls and privilege targets", () => {
    for (const sql of ["CALL prod_app.purge_users()", "CALL `prod_app`.`purge_users`()", "GRANT ALL ON prod_app.* TO 'u'@'%'", "GRANT EXECUTE ON PROCEDURE prod_app.purge_users TO 'u'@'%'"]) {
      expect(assessProductionSql(sql, connection(), "staging")).toMatchObject({ active: true, isMutation: true, databases: ["prod_app"] });
    }
  });

  it("allows resolved non-production procedure and privilege targets", () => {
    expect(assessProductionSql("CALL staging.purge_users()", connection(), "staging")).toMatchObject({ active: false, isMutation: true });
    expect(assessProductionSql("GRANT ALL ON staging.* TO 'u'@'%'", connection(), "staging")).toMatchObject({ active: false, isMutation: true });
  });

  it("conservatively confirms ambiguous production targets", () => {
    for (const sql of ["CALL purge_users()", "GRANT PROCESS ON *.* TO 'u'@'%'", "GRANT ALL ON users TO 'u'@'%'", "CREATE USER 'u'@'%'"]) {
      expect(assessProductionSql(sql, connection(), "staging")).toMatchObject({ active: true, isMutation: true, databases: ["prod_app"] });
    }
  });

  it("does not treat read-only qualified references as write targets", () => {
    expect(assessProductionSql("SELECT * FROM prod_app.orders; DELETE FROM staging.users WHERE id = 1", connection(), "staging")).toMatchObject({ active: false, isMutation: true });
  });

  it("treats unrecognized SQL as a production mutation until proven read-only", () => {
    expect(isProductionMutation("MAINTAIN UNKNOWN THING")).toBe(true);
    expect(assessProductionSql("MAINTAIN UNKNOWN THING", connection(), "prod_app")).toMatchObject({ active: true, isMutation: true });
  });

  it("does not require a production confirmation for reads", () => {
    expect(assessProductionSql("SELECT * FROM prod_app.orders", connection(), "staging")).toMatchObject({ active: false, isMutation: false });
  });
});
