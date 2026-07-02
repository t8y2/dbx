import { strict as assert } from "node:assert";
import { test } from "vitest";
import { effectiveDatabaseTypeForConnection, inferJdbcDialect } from "../../apps/desktop/src/lib/jdbcDialect.ts";

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
