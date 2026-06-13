import { test } from "vitest";
import assert from "node:assert/strict";
import { connectionUrlPlaceholder } from "../../apps/desktop/src/lib/connectionPresentation.ts";

const expected: Record<string, string> = {
  mysql: "mysql://user:password@host:port/database",
  doris: "mysql://user:password@host:port/database",
  starrocks: "mysql://user:password@host:port/database",
  manticoresearch: "mysql://user:password@host:port/database",
  postgres: "postgresql://user:password@host:port/database",
  gaussdb: "postgresql://user:password@host:port/database",
  kwdb: "postgresql://user:password@host:port/database",
  redshift: "postgresql://user:password@host:port/database",
  redis: "redis://:password@host:port/0",
  sqlite: "sqlite:///absolute/path/to/database.db",
  rqlite: "http://user:password@host:4001",
  duckdb: "duckdb:///absolute/path/to/database.duckdb",
  access: "jdbc:ucanaccess:///absolute/path/to/database.accdb",
  mongodb: "mongodb://user:password@host:port/database",
  clickhouse: "clickhouse://user:password@host:port/database",
  sqlserver: "mssql://user:password@host:port/database",
  oracle: "oracle://user:password@host:port/service_name",
  elasticsearch: "http://user:password@host:port",
  dameng: "dm://user:password@host:port",
  tdengine: "tdengine://user:password@host:6041/database",
  xugu: "xugu://user:password@host:5138/database",
  iotdb: "iotdb://user:password@host:6667/root.test",
  bigquery: "bigquery://https://www.googleapis.com/bigquery/v2:443/project-id",
  jdbc: "jdbc:mysql://host:3306/database",
};

for (const [dbType, placeholder] of Object.entries(expected)) {
  test(`returns correct placeholder for ${dbType}`, () => {
    assert.equal(connectionUrlPlaceholder(dbType as any), placeholder);
  });
}

test("falls back to postgresql placeholder for unknown type", () => {
  assert.equal(connectionUrlPlaceholder("unknown" as any), "postgresql://user:password@host:port/database");
});

test("mysql-family types share the same placeholder", () => {
  const mysql = connectionUrlPlaceholder("mysql");
  assert.equal(connectionUrlPlaceholder("doris"), mysql);
  assert.equal(connectionUrlPlaceholder("starrocks"), mysql);
  assert.equal(connectionUrlPlaceholder("manticoresearch"), mysql);
});

test("postgres-family types share the same placeholder", () => {
  const postgres = connectionUrlPlaceholder("postgres");
  assert.equal(connectionUrlPlaceholder("gaussdb"), postgres);
  assert.equal(connectionUrlPlaceholder("kwdb"), postgres);
  assert.equal(connectionUrlPlaceholder("redshift"), postgres);
});

test("each placeholder starts with the expected scheme", () => {
  for (const [dbType, placeholder] of Object.entries(expected)) {
    const scheme = placeholder.split("://")[0];
    assert.ok(scheme.length > 0, `${dbType} placeholder should have a scheme`);
  }
});
