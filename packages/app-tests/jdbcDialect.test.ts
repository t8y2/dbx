import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  codeMirrorSqlDialectForConnection,
  connectionShouldDiscoverJdbcSchemas,
  connectionShouldLoadIdentifierQuote,
  connectionUsesConnectionRootSchemaMode,
  connectionUsesDatabaseObjectTreeMode,
  effectiveDatabaseTypeForConnection,
  gaussdbIdentifierQuoteOverride,
  gaussdbIdentifierQuoteStyle,
  inferJdbcDialect,
  setGaussdbIdentifierQuoteStyle,
  sqlSnippetDatabaseTypeForConnection,
  supportsGaussdbIdentifierQuoteStyle,
} from "../../apps/desktop/src/lib/database/jdbcDialect.ts";

test("infers GoldenDB for generic JDBC connections", () => {
  assert.equal(
    inferJdbcDialect({
      db_type: "jdbc",
      connection_string: "jdbc:goldendb://127.0.0.1:3306/app",
    }),
    "goldendb",
  );
  assert.equal(
    effectiveDatabaseTypeForConnection({
      db_type: "jdbc",
      jdbc_driver_class: "com.goldendb.jdbc.Driver",
    }),
    "goldendb",
  );
});

test("infers JDBC dialect from driver profile", () => {
  assert.equal(
    inferJdbcDialect({
      db_type: "jdbc",
      driver_profile: "sqlserver",
    }),
    "sqlserver",
  );
});

test("Oracle JDBC uses connection-root schema navigation", () => {
  const connection = {
    db_type: "jdbc" as const,
    connection_string: "jdbc:oracle:thin:@//127.0.0.1:1521/XE",
  };

  assert.equal(connectionUsesConnectionRootSchemaMode(connection), true);
  assert.equal(connectionUsesDatabaseObjectTreeMode(connection), false);
});

test("uses dedicated ClickHouse editor syntax for inferred JDBC connections", () => {
  const connection = {
    db_type: "jdbc" as const,
    connection_string: "jdbc:clickhouse://127.0.0.1:8123/default",
  };

  assert.equal(inferJdbcDialect(connection), "clickhouse");
  assert.equal(codeMirrorSqlDialectForConnection(connection), "clickhouse");
});

test("infers GaussDB-compatible JDBC connections as schema-aware", () => {
  const gaussdbConnection = {
    db_type: "jdbc" as const,
    connection_string: "jdbc:gaussdb://127.0.0.1:8000/testdb",
    jdbc_driver_class: "com.huawei.gaussdb.jdbc.Driver",
  };
  const opengaussConnection = {
    db_type: "jdbc" as const,
    connection_string: "jdbc:opengauss://127.0.0.1:5432/postgres",
    jdbc_driver_class: "org.opengauss.Driver",
  };

  assert.equal(inferJdbcDialect(gaussdbConnection), "gaussdb");
  assert.equal(connectionUsesDatabaseObjectTreeMode(gaussdbConnection), false);
  assert.equal(inferJdbcDialect(opengaussConnection), "opengauss");
  assert.equal(connectionUsesDatabaseObjectTreeMode(opengaussConnection), false);
});

test("loads driver-reported identifier quotes for compatible JDBC connections", () => {
  assert.equal(connectionShouldLoadIdentifierQuote({ db_type: "jdbc", jdbc_driver_paths: ["/drivers/gaussdb.jar"] }), true);
  assert.equal(connectionShouldLoadIdentifierQuote({ db_type: "jdbc", jdbc_driver_class: "org.opengauss.Driver" }), true);
  assert.equal(connectionShouldLoadIdentifierQuote({ db_type: "jdbc", jdbc_driver_class: "org.postgresql.Driver" }), true);
  assert.equal(connectionShouldLoadIdentifierQuote({ db_type: "kingbase" }), true);
  assert.equal(connectionShouldLoadIdentifierQuote({ db_type: "gaussdb" }), true);
});

test("GaussDB server metadata overrides PostgreSQL-compatible JDBC driver identity", () => {
  const connection = {
    db_type: "jdbc" as const,
    connection_string: "jdbc:postgresql://localhost:5432/postgres",
    jdbc_driver_class: "org.postgresql.Driver",
    database_info: { productName: "GaussDB Kernel" },
  };

  assert.equal(inferJdbcDialect(connection), "gaussdb");
  assert.equal(effectiveDatabaseTypeForConnection(connection), "gaussdb");
  assert.equal(connectionShouldLoadIdentifierQuote(connection), true);
});

test("persists and resolves GaussDB identifier quote overrides", () => {
  const config = {
    db_type: "jdbc" as const,
    jdbc_driver_paths: ["/drivers/gaussdb.jar"],
    external_config: { retained: true } as unknown,
  };

  assert.equal(supportsGaussdbIdentifierQuoteStyle(config), true);
  assert.equal(gaussdbIdentifierQuoteStyle(config), "auto");
  setGaussdbIdentifierQuoteStyle(config, "backtick");
  assert.deepEqual(config.external_config, { retained: true, gaussdbIdentifierQuoteStyle: "backtick" });
  assert.equal(gaussdbIdentifierQuoteOverride(config), "`");
  assert.equal(connectionShouldLoadIdentifierQuote(config), false);
});

test("infers Dameng JDBC connections", () => {
  const damengConnection = {
    db_type: "jdbc" as const,
    connection_string: "jdbc:dm://127.0.0.1:5236/DAMENG",
    jdbc_driver_class: "dm.jdbc.driver.DmDriver",
  };

  assert.equal(inferJdbcDialect(damengConnection), "dameng");
});

test("discovers schemas only for unknown generic JDBC connections", () => {
  assert.equal(connectionShouldDiscoverJdbcSchemas({ db_type: "jdbc", driver_profile: "jdbc" }), true);
  assert.equal(connectionShouldDiscoverJdbcSchemas({ db_type: "jdbc", connection_string: "jdbc:mysql://127.0.0.1:3306/app" }), false);
});

test("keeps Phoenix on the generic JDBC metadata and object tree path", () => {
  const connection = {
    db_type: "jdbc" as const,
    driver_profile: "phoenix",
    connection_string: "jdbc:phoenix:localhost",
    jdbc_driver_class: "org.apache.phoenix.jdbc.PhoenixDriver",
  };

  assert.equal(inferJdbcDialect(connection), undefined);
  assert.equal(effectiveDatabaseTypeForConnection(connection), "jdbc");
  assert.equal(connectionShouldDiscoverJdbcSchemas(connection), true);
  assert.equal(connectionUsesDatabaseObjectTreeMode(connection), true);
});

test("uses SQL Server editor syntax for ASE without changing its effective JDBC type", () => {
  const aseConnections = [
    { db_type: "jdbc" as const, driver_profile: "ase" },
    { db_type: "jdbc" as const, driver_label: "SAP ASE 15" },
    { db_type: "jdbc" as const, database_info: { productName: "Adaptive Server Enterprise" } },
  ];

  for (const connection of aseConnections) {
    assert.equal(codeMirrorSqlDialectForConnection(connection), "sqlserver");
    assert.equal(sqlSnippetDatabaseTypeForConnection(connection), "sqlserver");
    assert.equal(effectiveDatabaseTypeForConnection(connection), "jdbc");
  }
});

test("keeps non-ASE jConnect profiles on generic JDBC syntax", () => {
  const iqConnection = {
    db_type: "jdbc" as const,
    driver_profile: "jdbc",
    driver_label: "SAP IQ",
    connection_string: "jdbc:sybase:Tds:127.0.0.1:2638/app",
    jdbc_driver_class: "com.sybase.jdbc4.jdbc.SybDriver",
    jdbc_driver_paths: ["C:\\drivers\\jconn4.jar"],
    database_info: { productName: "SAP IQ" },
  };

  assert.equal(codeMirrorSqlDialectForConnection(iqConnection), "mysql");
  assert.equal(sqlSnippetDatabaseTypeForConnection(iqConnection), "jdbc");
  assert.equal(effectiveDatabaseTypeForConnection(iqConnection), "jdbc");
});
