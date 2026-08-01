import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAgentVersionBump } from "./bump-agent-versions.mjs";

const moduleExists = (path) => path === "agents/drivers/duckdb";

test("keeps the manually registered first DuckDB driver version", () => {
  const result = evaluateAgentVersionBump({
    versions: { duckdb: "0.1.0" },
    prevVersions: {},
    changedFiles: ["agents/versions.json", "agents/drivers/duckdb/src/main.rs"],
    moduleExists,
    readModuleFile: () => "",
  });

  assert.equal(result.versions.duckdb, "0.1.0");
  assert.equal(result.changed, false);
  assert.match(result.logs.join("\n"), /new module version kept at 0\.1\.0/);
});

test("bumps DuckDB after its initial release", () => {
  const result = evaluateAgentVersionBump({
    versions: { duckdb: "0.1.0" },
    changedFiles: ["agents/drivers/duckdb/src/main.rs"],
    moduleExists,
    readModuleFile: () => "",
  });

  assert.equal(result.versions.duckdb, "0.1.1");
});

test("bumps the native RabbitMQ agent from its Go directory", () => {
  const result = evaluateAgentVersionBump({
    versions: { rabbitmq: "0.1.0" },
    changedFiles: ["agents/drivers/rabbitmq/main.go"],
    moduleExists: (path) => path === "agents/drivers/rabbitmq",
    readModuleFile: () => "",
  });

  assert.equal(result.versions.rabbitmq, "0.1.1");
});
