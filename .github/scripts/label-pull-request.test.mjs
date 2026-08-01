import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluatePullRequestLabels,
  inferAddedDependencies,
  inferDatabaseTypes,
  parseCargoDependencyNames,
  parseGoDependencyNames,
  parseGradleDependencyNames,
  parseMavenDependencyNames,
  parsePackageDependencyNames,
} from "./label-pull-request.mjs";

const knownDatabaseTypes = new Set([
  "access",
  "doris",
  "jdbc",
  "mongodb",
  "mq",
  "mysql",
  "oceanbase-oracle",
  "oracle",
  "postgres",
  "redis",
  "sqlite",
  "sqlserver",
]);

test("labels a desktop MySQL UI fix", () => {
  const result = evaluatePullRequestLabels({
    title: "fix(mysql): improve connection dialog",
    changedFiles: [
      "apps/desktop/src/components/connection/MySqlConnectionDialog.vue",
      "apps/desktop/src/i18n/en.ts",
    ],
    knownDatabaseTypes,
  });

  assert.deepEqual(result.labels, ["area/desktop", "bug", "db/mysql", "ui-change"]);
});

test("labels documentation-only changes without a conventional title", () => {
  const result = evaluatePullRequestLabels({
    title: "Improve installation notes",
    changedFiles: ["README.md", "docs/content/docs/install.mdx"],
    knownDatabaseTypes,
  });

  assert.deepEqual(result.labels, ["area/docs", "documentation"]);
});

test("maps agent and dialect paths to existing database types", () => {
  assert.deepEqual(
    inferDatabaseTypes([
      "agents/drivers/oracle-go/go.mod",
      "agents/drivers/kafka/build.gradle",
      "plugins/dialects/postgresql.yaml",
      "plugins/dialects/oceanbase.yaml",
    ], knownDatabaseTypes),
    ["mq", "oceanbase-oracle", "oracle", "postgres"],
  );
});

test("labels tests-only changes", () => {
  const result = evaluatePullRequestLabels({
    title: "test(core): cover transaction recovery",
    changedFiles: [
      "crates/dbx-core/tests/transaction_recovery.rs",
      "apps/desktop/src/lib/__tests__/transactionRecovery.spec.ts",
    ],
    knownDatabaseTypes,
  });

  assert.deepEqual(result.labels, ["area/core", "area/desktop", "maintenance", "tests-only"]);
});

test("does not treat component tests or MCP server code as UI or deploy changes", () => {
  const result = evaluatePullRequestLabels({
    title: "🐛 fix(mcp): cover server routing",
    changedFiles: [
      "apps/desktop/src/components/mcp/McpPanel.spec.ts",
      "packages/mcp-server/src/index.ts",
    ],
    knownDatabaseTypes,
  });

  assert.deepEqual(result.labels, ["area/desktop", "area/mcp", "bug"]);
});

test("recognizes conventional titles with a full-width colon", () => {
  const result = evaluatePullRequestLabels({
    title: "Fix：补全 GaussDB M 模式 SQL 生成",
    changedFiles: ["crates/dbx-core/src/db/mod.rs"],
    knownDatabaseTypes,
  });

  assert.deepEqual(result.labels, ["area/core", "bug"]);
});

test("collapses broad area and database changes", () => {
  const result = evaluatePullRequestLabels({
    title: "feat: add cross-runtime geometry support",
    changedFiles: [
      "agents/drivers/mysql/build.gradle",
      "apps/desktop/src/components/grid/GeometryViewer.vue",
      "crates/dbx-core/src/db/postgres.rs",
      "crates/dbx-mcp/src/main.rs",
      "crates/dbx-web/src/main.rs",
      "docs/content/docs/geometry.mdx",
      "plugins/dialects/sqlite.yaml",
      "plugins/dialects/sqlserver.yaml",
    ],
    knownDatabaseTypes,
  });

  assert.deepEqual(result.labels, ["area/multiple", "db/multiple", "enhancement", "ui-change"]);
  assert.deepEqual(result.databaseTypes, ["mysql", "postgres", "sqlite", "sqlserver"]);
});

test("detects only newly added package dependencies", () => {
  const result = inferAddedDependencies(
    ["package.json"],
    () => JSON.stringify({ dependencies: { vue: "3.5.0", pinia: "2.0.0" } }),
    () => JSON.stringify({ dependencies: { vue: "3.6.0", pinia: "2.0.0", zod: "4.0.0" } }),
  );

  assert.deepEqual([...result.frontend], ["package.json:zod"]);
  assert.equal(result.backend.size, 0);
});

test("detects frontend and backend additions in the same pull request", () => {
  const manifests = {
    base: {
      "package.json": JSON.stringify({ dependencies: { vue: "3.5.0" } }),
      "crates/dbx-core/Cargo.toml": "[dependencies]\ntokio = \"1\"\n",
    },
    head: {
      "package.json": JSON.stringify({ dependencies: { vue: "3.5.0", zod: "4" } }),
      "crates/dbx-core/Cargo.toml": "[dependencies]\ntokio = \"1\"\nserde = \"1\"\n",
    },
  };
  const result = evaluatePullRequestLabels({
    title: "feat(core): add validated settings",
    changedFiles: ["package.json", "crates/dbx-core/Cargo.toml", "pnpm-lock.yaml", "Cargo.lock"],
    knownDatabaseTypes,
    readBaseFile: (file) => manifests.base[file],
    readHeadFile: (file) => manifests.head[file],
  });

  assert.deepEqual(result.labels, [
    "area/core",
    "area/desktop",
    "dependencies/backend",
    "dependencies/frontend",
    "enhancement",
  ]);
});

test("ignores lockfile-only dependency changes", () => {
  const result = evaluatePullRequestLabels({
    title: "chore: refresh lockfiles",
    changedFiles: ["pnpm-lock.yaml", "Cargo.lock", "agents/drivers/xugu/go.sum"],
    knownDatabaseTypes,
  });

  assert.deepEqual(result.labels, ["area/agents", "maintenance"]);
});

test("parses dependency names from supported backend manifests", () => {
  assert.deepEqual(
    [...parseCargoDependencyNames(`
[workspace.dependencies]
serde = "1"

[target.'cfg(windows)'.dependencies]
windows-sys = "0.61"

[dependencies.mysql_async]
git = "https://example.com/mysql_async"
`)].sort(),
    ["mysql_async", "serde", "windows-sys"],
  );
  assert.deepEqual(
    [...parseGradleDependencyNames(`
implementation 'com.zaxxer:HikariCP:7.0.2'
testImplementation project(':test-support')
runtimeOnly libs.slf4j.nop
`)].sort(),
    ["catalog:libs.slf4j.nop", "com.zaxxer:HikariCP", "project::test-support"],
  );
  assert.deepEqual(
    [...parseGoDependencyNames(`
require github.com/example/direct v1.0.0
require (
  github.com/example/block v2.0.0
)
`)].sort(),
    ["github.com/example/block", "github.com/example/direct"],
  );
  assert.deepEqual(
    [...parseMavenDependencyNames(`
<dependencies>
  <dependency><groupId>org.example</groupId><artifactId>client</artifactId><version>1</version></dependency>
</dependencies>
`)],
    ["org.example:client"],
  );
  assert.deepEqual(
    [...parsePackageDependencyNames(JSON.stringify({
      dependencies: { vue: "3" },
      devDependencies: { vitest: "4" },
    }))].sort(),
    ["vitest", "vue"],
  );
});
