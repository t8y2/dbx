import assert from "node:assert/strict";
import test from "node:test";
import {
  connectionObjectTreeQuerySchema,
  connectionUsesDatabaseObjectTreeMode,
  effectiveDatabaseTypeForConnection,
  inferJdbcDialect,
} from "../../apps/desktop/src/lib/jdbcDialect.ts";
import { supportsTableStructureEditing } from "../../apps/desktop/src/lib/databaseFeatureSupport.ts";
import { qualifiedTableName } from "../../apps/desktop/src/lib/tableSelectSql.ts";

test("infers JDBC dialect from URL, driver class, and driver jar path", () => {
  assert.equal(
    inferJdbcDialect({ db_type: "jdbc", connection_string: "jdbc:mysql://db.example.com:9030/demo" }),
    "mysql",
  );
  assert.equal(
    inferJdbcDialect({ db_type: "jdbc", jdbc_driver_class: "org.apache.kyuubi.jdbc.KyuubiHiveDriver" }),
    "mysql",
  );
  assert.equal(inferJdbcDialect({ db_type: "jdbc", jdbc_driver_class: "org.apache.hive.jdbc.HiveDriver" }), "hive");
  assert.equal(
    inferJdbcDialect({ db_type: "jdbc", jdbc_driver_paths: ["/drivers/starrocks-jdbc.jar"] }),
    "starrocks",
  );
});

test("effective database type keeps non-JDBC types and enables compatible JDBC structure editing", () => {
  assert.equal(effectiveDatabaseTypeForConnection({ db_type: "postgres" }), "postgres");
  assert.equal(effectiveDatabaseTypeForConnection({ db_type: "jdbc" }), "jdbc");
  assert.equal(
    effectiveDatabaseTypeForConnection({ db_type: "jdbc", jdbc_driver_class: "org.apache.kyuubi.jdbc.KyuubiHiveDriver" }),
    "mysql",
  );
  assert.equal(
    supportsTableStructureEditing(
      effectiveDatabaseTypeForConnection({ db_type: "jdbc", jdbc_driver_class: "org.apache.kyuubi.jdbc.KyuubiHiveDriver" }),
    ),
    true,
  );
  assert.equal(supportsTableStructureEditing(effectiveDatabaseTypeForConnection({ db_type: "jdbc" })), false);
});

test("JDBC tree shape follows the inferred driver dialect", () => {
  const kyuubi = { db_type: "jdbc" as const, jdbc_driver_class: "org.apache.kyuubi.jdbc.KyuubiHiveDriver" };
  const hive = { db_type: "jdbc" as const, jdbc_driver_class: "org.apache.hive.jdbc.HiveDriver" };

  assert.equal(connectionUsesDatabaseObjectTreeMode(kyuubi), true);
  assert.equal(connectionObjectTreeQuerySchema(kyuubi, "test", undefined), "");
  assert.equal(connectionUsesDatabaseObjectTreeMode(hive), false);
  assert.equal(connectionObjectTreeQuerySchema(hive, "spark_catalog", "test"), "test");
  assert.equal(
    qualifiedTableName({
      databaseType: effectiveDatabaseTypeForConnection(hive),
      schema: connectionObjectTreeQuerySchema(hive, "spark_catalog", "test"),
      tableName: "dws_event_analyse",
    }),
    "`test`.`dws_event_analyse`",
  );
});
