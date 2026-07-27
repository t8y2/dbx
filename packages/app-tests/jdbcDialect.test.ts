import { strict as assert } from "node:assert";
import { test } from "vitest";
import { codeMirrorSqlDialectForConnection, connectionShouldDiscoverJdbcSchemas, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection, inferJdbcDialect, sqlSnippetDatabaseTypeForConnection } from "../../apps/desktop/src/lib/database/jdbcDialect.ts";

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
