import { describe, expect, it } from "vitest";
import { connectionObjectTreeNodeSchema, connectionQueryExecutionSchema, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection, inferJdbcDialect } from "@/lib/database/jdbcDialect";

describe("jdbc dialect inference", () => {
  it("detects InterSystems IRIS and Caché JDBC connections", () => {
    expect(
      inferJdbcDialect({
        db_type: "jdbc",
        connection_string: "jdbc:IRIS://localhost:1972/USER",
      }),
    ).toBe("iris");
    expect(
      inferJdbcDialect({
        db_type: "jdbc",
        connection_string: "jdbc:Cache://localhost:1972/USER",
      }),
    ).toBe("iris");
    expect(
      inferJdbcDialect({
        db_type: "jdbc",
        jdbc_driver_class: "com.intersystems.jdbc.IRISDriver",
      }),
    ).toBe("iris");
    expect(
      inferJdbcDialect({
        db_type: "jdbc",
        jdbc_driver_paths: ["/drivers/intersystems-jdbc-3.10.5.jar"],
      }),
    ).toBe("iris");
  });

  it("uses IRIS table preview dialect for generic JDBC IRIS connections", () => {
    expect(
      effectiveDatabaseTypeForConnection({
        db_type: "jdbc",
        connection_string: "jdbc:IRIS://localhost:1972/USER",
      }),
    ).toBe("iris");
  });

  it("uses JDBC driver profiles when inferring dialect", () => {
    expect(
      inferJdbcDialect({
        db_type: "jdbc",
        driver_profile: "sqlserver",
      }),
    ).toBe("sqlserver");
  });

  it("detects GaussDB-compatible JDBC connections as schema-aware", () => {
    const gaussdbConnection = {
      db_type: "jdbc" as const,
      connection_string: "jdbc:gaussdb://localhost:8000/testdb",
      jdbc_driver_class: "com.huawei.gaussdb.jdbc.Driver",
    };
    const opengaussConnection = {
      db_type: "jdbc" as const,
      connection_string: "jdbc:opengauss://localhost:5432/postgres",
      jdbc_driver_class: "org.opengauss.Driver",
    };

    expect(inferJdbcDialect(gaussdbConnection)).toBe("gaussdb");
    expect(connectionUsesDatabaseObjectTreeMode(gaussdbConnection)).toBe(false);
    expect(inferJdbcDialect(opengaussConnection)).toBe("opengauss");
    expect(connectionUsesDatabaseObjectTreeMode(opengaussConnection)).toBe(false);
  });

  it("detects Dameng JDBC connections", () => {
    const damengConnection = {
      db_type: "jdbc" as const,
      connection_string: "jdbc:dm://localhost:5236/DAMENG",
      jdbc_driver_class: "dm.jdbc.driver.DmDriver",
    };

    expect(inferJdbcDialect(damengConnection)).toBe("dameng");
  });
});

describe("query execution schema", () => {
  it.each(["spark", "hive"] as const)("uses the selected database as the %s execution schema", (dbType) => {
    expect(connectionQueryExecutionSchema({ db_type: dbType }, "ai_test", undefined, false)).toBe("ai_test");
  });

  it("prefers an explicit schema for PostgreSQL", () => {
    expect(connectionQueryExecutionSchema({ db_type: "postgres" }, "app", "reporting", false)).toBe("reporting");
  });

  it("does not send a schema for MySQL database context", () => {
    expect(connectionQueryExecutionSchema({ db_type: "mysql" }, "app", undefined, false)).toBeUndefined();
  });

  it("does not change data-tab execution context", () => {
    expect(connectionQueryExecutionSchema({ db_type: "spark" }, "ai_test", undefined, true)).toBeUndefined();
  });

  it("keeps generic JDBC Databend schema fallback", () => {
    expect(connectionQueryExecutionSchema({ db_type: "jdbc", connection_string: "jdbc:databend://localhost:8000/default" }, "analytics", undefined, false)).toBe("analytics");
  });
});

describe("object tree node schema", () => {
  it("uses the SQLite database alias to qualify attached tables", () => {
    expect(connectionObjectTreeNodeSchema({ db_type: "sqlite" }, "analytics")).toBe("analytics");
  });
});
