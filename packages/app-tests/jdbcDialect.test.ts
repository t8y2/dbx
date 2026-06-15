import assert from "node:assert/strict";
import { test } from "vitest";
import { connectionObjectTreeNodeSchema, connectionObjectTreeQuerySchema, connectionUsesSchemaExecutionContext, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection, inferJdbcDialect, tableStructureDatabaseTypeForConnection } from "../../apps/desktop/src/lib/jdbcDialect.ts";
import { supportsTableStructureEditing } from "../../apps/desktop/src/lib/databaseFeatureSupport.ts";
import { qualifiedTableName } from "../../apps/desktop/src/lib/tableSelectSql.ts";

test("infers JDBC dialect from URL, driver class, and driver jar path", () => {
  assert.equal(inferJdbcDialect({ db_type: "jdbc", connection_string: "jdbc:mysql://db.example.com:9030/demo" }), "mysql");
  assert.equal(inferJdbcDialect({ db_type: "jdbc", jdbc_driver_class: "org.apache.kyuubi.jdbc.KyuubiHiveDriver" }), "mysql");
  assert.equal(inferJdbcDialect({ db_type: "jdbc", jdbc_driver_class: "org.apache.hive.jdbc.HiveDriver" }), "hive");
  assert.equal(inferJdbcDialect({ db_type: "jdbc", jdbc_driver_paths: ["/drivers/starrocks-jdbc.jar"] }), "starrocks");
  assert.equal(inferJdbcDialect({ db_type: "jdbc", connection_string: "jdbc:databend://db.example.com:8000/default" }), "databend");
});

test("effective database type keeps non-JDBC types and enables compatible JDBC structure editing", () => {
  assert.equal(effectiveDatabaseTypeForConnection({ db_type: "postgres" }), "postgres");
  assert.equal(effectiveDatabaseTypeForConnection({ db_type: "jdbc" }), "jdbc");
  assert.equal(effectiveDatabaseTypeForConnection({ db_type: "gbase", driver_profile: "gbase8s" }), "informix");
  assert.equal(effectiveDatabaseTypeForConnection({ db_type: "gbase", driver_profile: "gbase8a" }), "mysql");
  assert.equal(tableStructureDatabaseTypeForConnection({ db_type: "gbase", driver_profile: "gbase8a" }), "gbase");
  assert.equal(tableStructureDatabaseTypeForConnection({ db_type: "gbase", driver_profile: "gbase8s" }), "informix");
  assert.equal(
    effectiveDatabaseTypeForConnection({
      db_type: "jdbc",
      jdbc_driver_class: "org.apache.kyuubi.jdbc.KyuubiHiveDriver",
    }),
    "mysql",
  );
  assert.equal(
    supportsTableStructureEditing(
      effectiveDatabaseTypeForConnection({
        db_type: "jdbc",
        jdbc_driver_class: "org.apache.kyuubi.jdbc.KyuubiHiveDriver",
      }),
    ),
    true,
  );
  assert.equal(supportsTableStructureEditing(effectiveDatabaseTypeForConnection({ db_type: "jdbc" })), false);
});

test("JDBC tree shape follows the inferred driver dialect", () => {
  const kyuubi = { db_type: "jdbc" as const, jdbc_driver_class: "org.apache.kyuubi.jdbc.KyuubiHiveDriver" };
  const hive = { db_type: "jdbc" as const, jdbc_driver_class: "org.apache.hive.jdbc.HiveDriver" };
  const db2 = { db_type: "jdbc" as const, connection_string: "jdbc:db2://db.example.com:50000/SAMPLE" };

  assert.equal(connectionUsesDatabaseObjectTreeMode(kyuubi), true);
  assert.equal(connectionObjectTreeQuerySchema(kyuubi, "test", undefined), "");
  assert.equal(connectionUsesDatabaseObjectTreeMode(hive), false);
  assert.equal(connectionObjectTreeQuerySchema(hive, "spark_catalog", "test"), "test");
  assert.equal(connectionUsesDatabaseObjectTreeMode(db2), false);
  assert.equal(connectionObjectTreeQuerySchema(db2, "SAMPLE", "APP"), "APP");
  assert.equal(connectionObjectTreeNodeSchema(db2, "SAMPLE", "APP"), "APP");
  assert.equal(
    qualifiedTableName({
      databaseType: effectiveDatabaseTypeForConnection(hive),
      schema: connectionObjectTreeQuerySchema(hive, "spark_catalog", "test"),
      tableName: "dws_event_analyse",
    }),
    "`test`.`dws_event_analyse`",
  );
});

test("GBase profiles use their compatible object tree shapes", () => {
  const gbase8a = { db_type: "gbase" as const, driver_profile: "gbase8a" };
  const gbase8s = { db_type: "gbase" as const, driver_profile: "gbase8s" };

  assert.equal(connectionUsesDatabaseObjectTreeMode(gbase8a), false);
  assert.equal(connectionObjectTreeQuerySchema(gbase8a, "testdb", undefined), "");
  assert.equal(connectionObjectTreeNodeSchema(gbase8a, "testdb", undefined), undefined);
  assert.equal(connectionUsesDatabaseObjectTreeMode(gbase8s), false);
  assert.equal(connectionObjectTreeQuerySchema(gbase8s, "testdb", "gbasedbt"), "gbasedbt");
  assert.equal(connectionObjectTreeNodeSchema(gbase8s, "testdb", "gbasedbt"), "gbasedbt");
  assert.equal(connectionObjectTreeQuerySchema(gbase8s, "testdb", undefined), "testdb");
  assert.equal(connectionObjectTreeNodeSchema(gbase8s, "testdb", undefined), "testdb");
});

test("Databend JDBC keeps database as schema context for table data", () => {
  const databend = { db_type: "jdbc" as const, connection_string: "jdbc:databend://db.example.com:8000/dbx_test" };

  assert.equal(effectiveDatabaseTypeForConnection(databend), "databend");
  assert.equal(connectionUsesDatabaseObjectTreeMode(databend), true);
  assert.equal(connectionUsesSchemaExecutionContext(databend), true);
  assert.equal(connectionObjectTreeQuerySchema(databend, "dbx_test", undefined), "dbx_test");
  assert.equal(connectionObjectTreeNodeSchema(databend, "dbx_test", undefined), "dbx_test");
  assert.equal(
    qualifiedTableName({
      databaseType: effectiveDatabaseTypeForConnection(databend),
      schema: connectionObjectTreeNodeSchema(databend, "dbx_test", undefined),
      tableName: "jdbc_probe",
    }),
    "`dbx_test`.`jdbc_probe`",
  );
});
