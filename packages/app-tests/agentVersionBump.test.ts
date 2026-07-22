import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";

const { evaluateAgentVersionBump, getAgentVersionChanges } = await importScript(".github/scripts/bump-agent-versions.mjs");

function importScript(path: string): Promise<Record<string, any>> {
  const source = readFileSync(resolve(path), "utf8").replace(/^#!.*\r?\n/, "");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

function moduleFixture(paths: string[], files: Record<string, string> = {}) {
  const existing = new Set(paths);
  return {
    moduleExists: (path: string) => existing.has(path),
    readModuleFile: (path: string) => files[path] ?? "",
  };
}

test("common agent runtime changes bump only modules that package common", () => {
  const fixture = moduleFixture(
    [
      "agents/drivers/access",
      "agents/drivers/access/build.gradle",
      "agents/drivers/kafka",
      "agents/drivers/kafka/build.gradle",
      "agents/drivers/mongodb",
      "agents/drivers/mongodb/build.gradle",
      "agents/drivers/oracle-go",
      "agents/drivers/xugu",
    ],
    {
      "agents/drivers/mongodb/build.gradle": "dependencies { implementation project(':common') }",
    },
  );

  const result = evaluateAgentVersionBump({
    versions: {
      access: "0.1.0",
      kafka: "0.1.0",
      mongodb: "0.1.0",
      oracle: "0.1.0",
      xugu: "0.1.0",
    },
    changedFiles: ["agents/common/src/main/resources/agent-protocol-v1.json"],
    legacyStandaloneModules: new Set(["kafka", "mongodb"]),
    ...fixture,
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.versions, {
    access: "0.1.1",
    kafka: "0.1.0",
    mongodb: "0.1.1",
    oracle: "0.1.0",
    xugu: "0.1.0",
  });
});

test("common agent test changes do not bump driver versions", () => {
  const fixture = moduleFixture(["agents/drivers/access", "agents/drivers/access/build.gradle"]);

  const result = evaluateAgentVersionBump({
    versions: {
      access: "0.1.0",
    },
    changedFiles: ["agents/common/src/test/java/com/dbx/agent/AbstractJdbcAgentTest.java"],
    ...fixture,
  });

  assert.equal(result.changed, false);
  assert.deepEqual(result.versions, {
    access: "0.1.0",
  });
});

test("native agent source changes still bump native module versions", () => {
  const fixture = moduleFixture([
    "agents/drivers/access",
    "agents/drivers/access/build.gradle",
    "agents/drivers/oracle-go",
    "agents/drivers/xugu",
  ]);

  const result = evaluateAgentVersionBump({
    versions: {
      access: "0.1.0",
      oracle: "0.1.0",
      xugu: "0.1.0",
    },
    changedFiles: ["agents/drivers/oracle-go/main.go", "agents/drivers/xugu/main.go"],
    ...fixture,
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.versions, {
    access: "0.1.0",
    oracle: "0.1.1",
    xugu: "0.1.1",
  });
});

test("native agent tests and benchmarks do not bump module versions", () => {
  const fixture = moduleFixture([
    "agents/drivers/kingbase-go",
    "agents/drivers/xugu",
  ]);

  const result = evaluateAgentVersionBump({
    versions: {
      kingbase: "0.1.34",
      xugu: "0.1.21",
    },
    changedFiles: [
      "agents/drivers/kingbase-go/main_test.go",
      "agents/drivers/xugu/bench/compare.go",
    ],
    ...fixture,
  });

  assert.equal(result.changed, false);
  assert.deepEqual(result.versions, {
    kingbase: "0.1.34",
    xugu: "0.1.21",
  });
});

test("Kingbase native Go source changes bump the Kingbase module version", () => {
  const fixture = moduleFixture([
    "agents/drivers/kingbase",
    "agents/drivers/kingbase/build.gradle",
    "agents/drivers/kingbase-go",
  ]);

  const result = evaluateAgentVersionBump({
    versions: {
      kingbase: "0.1.34",
    },
    changedFiles: ["agents/drivers/kingbase-go/main.go"],
    ...fixture,
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.versions, {
    kingbase: "0.1.35",
  });
  assert.deepEqual(getAgentVersionChanges(result.prevVersions, result.versions), [
    { moduleName: "kingbase", previousVersion: "0.1.34", nextVersion: "0.1.35" },
  ]);
});

test("manual agent versions are preserved while other changed modules auto bump", () => {
  const fixture = moduleFixture([
    "agents/drivers/access",
    "agents/drivers/access/build.gradle",
    "agents/drivers/dameng",
    "agents/drivers/dameng/build.gradle",
  ]);

  const result = evaluateAgentVersionBump({
    versions: {
      access: "0.1.2",
      dameng: "0.1.0",
    },
    prevVersions: {
      access: "0.1.1",
      dameng: "0.1.0",
    },
    changedFiles: ["agents/common/src/main/java/com/dbx/agent/JdbcExecutor.java", "agents/versions.json"],
    ...fixture,
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.versions, {
    access: "0.1.2",
    dameng: "0.1.1",
  });
});
