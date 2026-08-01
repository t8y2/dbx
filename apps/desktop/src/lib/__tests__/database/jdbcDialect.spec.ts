import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import {
  GAUSSDB_M_JDBC_DRIVER_CLASS,
  connectionObjectTreeNodeSchema,
  connectionQueryExecutionSchema,
  connectionShouldLoadIdentifierQuote,
  connectionUsesDatabaseObjectTreeMode,
  effectiveDatabaseTypeForConnection,
  gaussdbConnectionMode,
  gaussdbIdentifierQuoteOverride,
  gaussdbIdentifierQuoteStyle,
  inferJdbcDialect,
  setGaussdbConnectionMode,
  setGaussdbIdentifierQuoteStyle,
  supportsGaussdbIdentifierQuoteStyle,
} from "@/lib/database/jdbcDialect";

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

  it("loads driver-reported identifier quotes for compatible JDBC connections", () => {
    expect(connectionShouldLoadIdentifierQuote({ db_type: "jdbc", jdbc_driver_paths: ["/drivers/gaussdb.jar"] })).toBe(true);
    expect(connectionShouldLoadIdentifierQuote({ db_type: "jdbc", jdbc_driver_class: "org.opengauss.Driver" })).toBe(true);
    expect(connectionShouldLoadIdentifierQuote({ db_type: "jdbc", jdbc_driver_class: "org.postgresql.Driver" })).toBe(true);
    expect(connectionShouldLoadIdentifierQuote({ db_type: "kingbase" })).toBe(true);
    expect(connectionShouldLoadIdentifierQuote({ db_type: "gaussdb" })).toBe(true);
    expect(
      connectionShouldLoadIdentifierQuote({
        db_type: "jdbc",
        jdbc_driver_class: "org.postgresql.Driver",
        external_config: { gaussdbIdentifierQuoteStyle: "backtick" },
      }),
    ).toBe(false);
  });

  it("recognizes GaussDB reached through PostgreSQL-compatible JDBC drivers", () => {
    const connection = {
      db_type: "jdbc" as const,
      connection_string: "jdbc:postgresql://localhost:5432/postgres",
      jdbc_driver_class: "org.postgresql.Driver",
      database_info: { productName: "GaussDB Kernel", driverName: "PostgreSQL JDBC Driver" },
    };

    expect(inferJdbcDialect(connection)).toBe("gaussdb");
    expect(effectiveDatabaseTypeForConnection(connection)).toBe("gaussdb");
    expect(supportsGaussdbIdentifierQuoteStyle(connection)).toBe(true);
  });

  it("supports persisted GaussDB identifier quote overrides", () => {
    const native = { db_type: "gaussdb" as const, external_config: undefined as unknown };
    const jdbc = { db_type: "jdbc" as const, jdbc_driver_paths: ["/drivers/gaussdb.jar"], external_config: { retained: true } as unknown };

    expect(supportsGaussdbIdentifierQuoteStyle(native)).toBe(true);
    expect(gaussdbIdentifierQuoteStyle(native)).toBe("auto");
    expect(gaussdbIdentifierQuoteOverride(native)).toBeUndefined();

    setGaussdbIdentifierQuoteStyle(native, "backtick");
    expect(gaussdbIdentifierQuoteStyle(native)).toBe("backtick");
    expect(gaussdbIdentifierQuoteOverride(native)).toBe("`");

    setGaussdbIdentifierQuoteStyle(jdbc, "double");
    expect(jdbc.external_config).toEqual({ retained: true, gaussdbIdentifierQuoteStyle: "double" });
    expect(gaussdbIdentifierQuoteOverride(jdbc)).toBe('"');
    expect(connectionShouldLoadIdentifierQuote(jdbc)).toBe(false);

    setGaussdbIdentifierQuoteStyle(jdbc, "auto");
    expect(jdbc.external_config).toEqual({ retained: true });
    expect(connectionShouldLoadIdentifierQuote(jdbc)).toBe(true);
  });

  it("detects Dameng JDBC connections", () => {
    const damengConnection = {
      db_type: "jdbc" as const,
      connection_string: "jdbc:dm://localhost:5236/DAMENG",
      jdbc_driver_class: "dm.jdbc.driver.DmDriver",
    };

    expect(inferJdbcDialect(damengConnection)).toBe("dameng");
  });

  it("uses Hive tree and execution semantics for Inceptor JDBC metadata", () => {
    const connection = {
      db_type: "jdbc" as const,
      connection_string: "jdbc:hive2://inceptor.example.com:10000/default",
      database_info: { productName: "Apache Hive", driverName: "Inceptor JDBC 8.37.3" },
    };

    expect(inferJdbcDialect(connection)).toBe("hive");
    expect(effectiveDatabaseTypeForConnection(connection)).toBe("hive");
    expect(connectionUsesDatabaseObjectTreeMode(connection)).toBe(false);
    expect(connectionObjectTreeNodeSchema(connection, "CS")).toBe("CS");
    expect(connectionQueryExecutionSchema(connection, "CS", undefined, false)).toBe("CS");
  });

  it.each([
    { driver_profile: "inceptor" },
    { driver_label: "Inceptor JDBC 8.37.3" },
    { jdbc_driver_class: "io.transwarp.inceptor.jdbc.InceptorDriver" },
    { jdbc_driver_paths: ["C:\\drivers\\InceptorJDBC.jar"] },
    { database_info: { driverName: "Inceptor JDBC 8.37.3" } },
    { database_info: { serverComment: "Transwarp Inceptor Server" } },
  ])("detects Inceptor from explicit JDBC identity %#", (identity) => {
    expect(inferJdbcDialect({ db_type: "jdbc", ...identity })).toBe("hive");
  });

  it("recognizes Apache Hive metadata without changing generic hive2 or MySQL inference", () => {
    expect(inferJdbcDialect({ db_type: "jdbc", database_info: { productName: "Apache Hive" } })).toBe("hive");
    expect(inferJdbcDialect({ db_type: "jdbc", driver_label: "Kyuubi JDBC", connection_string: "jdbc:hive2://kyuubi.example.com/default" })).toBe("mysql");
    expect(inferJdbcDialect({ db_type: "jdbc", connection_string: "jdbc:hive2://hiveserver.example.com/default" })).toBe("mysql");
    expect(inferJdbcDialect({ db_type: "jdbc", connection_string: "jdbc:mysql://mysql.example.com/app" })).toBe("mysql");
  });

  it("prefers explicit Kyuubi identity over Apache Hive product metadata", () => {
    expect(inferJdbcDialect({ db_type: "jdbc", driver_label: "Kyuubi JDBC", database_info: { productName: "Apache Hive" } })).toBe("mysql");
  });
});

describe("GaussDB connection mode", () => {
  it("keeps native connections compatible and configures M mode for the vendor JDBC driver", () => {
    const connection = { db_type: "gaussdb", driver_profile: "gaussdb", driver_label: "GaussDB" } as ConnectionConfig;

    expect(gaussdbConnectionMode(connection)).toBe("native");
    setGaussdbConnectionMode(connection, "m-jdbc");
    expect(connection.driver_profile).toBe("gaussdb-m");
    expect(connection.jdbc_driver_class).toBe(GAUSSDB_M_JDBC_DRIVER_CLASS);
    expect(gaussdbIdentifierQuoteOverride(connection)).toBeUndefined();

    setGaussdbConnectionMode(connection, "native");
    expect(connection.driver_profile).toBe("gaussdb");
    expect(connection.jdbc_driver_class).toBeUndefined();
  });
});

describe("query execution schema", () => {
  it.each(["spark", "hive"] as const)("uses the selected database as the %s execution schema", (dbType) => {
    expect(connectionQueryExecutionSchema({ db_type: dbType }, "ai_test", undefined, false)).toBe("ai_test");
  });

  it("prefers an explicit schema for PostgreSQL", () => {
    expect(connectionQueryExecutionSchema({ db_type: "postgres" }, "app", "reporting", false)).toBe("reporting");
  });

  it("prefers an explicit schema for Kingbase query execution", () => {
    expect(connectionQueryExecutionSchema({ db_type: "kingbase" }, "qinzhou", "sdy_smartsite", false)).toBe("sdy_smartsite");
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
