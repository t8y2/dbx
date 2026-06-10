import { strict as assert } from "node:assert";
import { test } from "vitest";
import { h2ConnectionModeForConfig, h2FileJdbcUrl, h2FilePathFromJdbcUrl, h2JdbcFileBasePath } from "../../apps/desktop/src/lib/h2Connection.ts";

test("H2 file JDBC URL strips database file suffixes", () => {
  assert.equal(h2JdbcFileBasePath("/data/app.mv.db"), "/data/app");
  assert.equal(h2JdbcFileBasePath("/data/app.h2.db"), "/data/app");
  assert.equal(h2FileJdbcUrl("/data/app.mv.db"), "jdbc:h2:file:/data/app;AUTO_SERVER=TRUE");
});

test("H2 file path is parsed from JDBC URL with options", () => {
  assert.equal(h2FilePathFromJdbcUrl("jdbc:h2:file:/data/app;AUTO_SERVER=TRUE"), "/data/app");
});

test("H2 connection mode preserves TCP connections unless file mode is explicit", () => {
  assert.equal(h2ConnectionModeForConfig({ db_type: "h2", port: 9092, connection_string: undefined }), "tcp");
  assert.equal(h2ConnectionModeForConfig({ db_type: "h2", port: 0, connection_string: undefined }), "file");
  assert.equal(h2ConnectionModeForConfig({ db_type: "h2", port: 9092, connection_string: "jdbc:h2:file:/data/app" }), "file");
});
