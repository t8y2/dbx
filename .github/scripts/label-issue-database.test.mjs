import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { databaseIssueDrivers } from "./database-issue-catalog.mjs";
import { allDatabaseLabelSpecs, triageIssue } from "./label-issue-database.mjs";

function databaseTypeNames() {
  const source = fs.readFileSync(new URL("../../apps/desktop/src/types/database.ts", import.meta.url), "utf8");
  const declaration = source.match(/export type DatabaseType\s*=([\s\S]*?);/u)?.[1] || "";
  return [...declaration.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

function issueWithDatabase(database, title = "[Bug]") {
  return {
    number: 1,
    title,
    body: `### 数据库类型和版本\n\n${database}\n`,
    labels: [],
  };
}

function matchedLabels(database, title) {
  return triageIssue(issueWithDatabase(database, title)).summary.labelsToAdd
    .filter((label) => label.startsWith("db/"))
    .sort();
}

test("database issue catalog covers every DatabaseType", () => {
  const catalogTypes = new Set(databaseIssueDrivers.map((driver) => driver.dbType));
  const missingTypes = databaseTypeNames().filter((dbType) => !catalogTypes.has(dbType));
  assert.deepEqual(missingTypes, []);
});

test("database label synchronization includes every catalog entry once", () => {
  const labelNames = allDatabaseLabelSpecs().map((label) => label.name);
  assert.equal(new Set(labelNames).size, databaseIssueDrivers.length);
  assert.deepEqual(
    labelNames.sort(),
    databaseIssueDrivers.map((driver) => `db/${driver.dbType}`).sort(),
  );
});

test("labels native and compatibility database products with their families", () => {
  const cases = [
    ["Turso", ["db/turso"]],
    ["Nacos 2.0.1", ["db/nacos"]],
    ["r-nacos", ["db/nacos"]],
    ["Apache Cloudberry", ["db/cloudberry", "db/postgres"]],
    ["TiDB v8.5", ["db/mysql", "db/tidb"]],
    ["OceanBase", ["db/oceanbase"]],
    ["OceanBase MySQL Mode", ["db/mysql", "db/oceanbase"]],
    ["OceanBase Oracle Mode", ["db/oceanbase", "db/oceanbase-oracle", "db/oracle"]],
    ["TDSQL", ["db/tdsql"]],
    ["PolarDB-X 2.0 MySQL", ["db/mysql", "db/polardb"]],
    ["SelectDB", ["db/doris", "db/selectdb"]],
    ["Dremio", ["db/dremio", "db/jdbc"]],
    ["Apache Kafka", ["db/kafka", "db/mq"]],
    ["RabbitMQ", ["db/mq", "db/rabbitmq"]],
  ];

  for (const [database, expected] of cases) {
    assert.deepEqual(matchedLabels(database), expected, database);
  }
});

test("generic OceanBase reports no longer default to Oracle mode", () => {
  assert.equal(matchedLabels("OceanBase").includes("db/oceanbase-oracle"), false);
});
