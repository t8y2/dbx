import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "vitest";

function readSource(path: string): string {
  return readFileSync(path, "utf8");
}

function functionBody(source: string, name: string): string {
  const signature = `function ${name}(`;
  const asyncSignature = `async ${signature}`;
  const signatureIndex = source.indexOf(asyncSignature) >= 0 ? source.indexOf(asyncSignature) : source.indexOf(signature);
  assert.notEqual(signatureIndex, -1, `Could not find function ${name}`);
  const bodyStart = source.indexOf("{", signatureIndex);
  assert.notEqual(bodyStart, -1, `Could not find body for ${name}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, index);
    }
  }
  throw new Error(`Could not parse body for ${name}`);
}

test("secondary write entrypoints use the shared production SQL guard", () => {
  const entrypoints = [
    {
      path: "apps/desktop/src/components/diff/SchemaDiffDialog.vue",
      executor: "api.executeScript",
      sourceKey: "production.sourceSchemaDiff",
    },
    {
      path: "apps/desktop/src/components/diff/DataCompareDialog.vue",
      executor: "api.executeBatch",
      sourceKey: "production.sourceDataCompare",
    },
    {
      path: "apps/desktop/src/components/objects/InstallExtensionDialog.vue",
      executor: "api.executeQuery",
      sourceKey: "production.sourceExtension",
    },
    {
      path: "apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue",
      executor: "api.executeQuery",
      sourceKey: "production.sourceSidebar",
    },
    {
      path: "apps/desktop/src/App.vue",
      executor: "executeObjectSourceSave",
      sourceKey: "production.sourceObjectSource",
    },
    {
      path: "apps/desktop/src/components/objects/ObjectSourceDialog.vue",
      executor: "executeObjectSourceSave",
      sourceKey: "production.sourceObjectSource",
    },
    {
      path: "apps/desktop/src/components/objects/ObjectBrowser.vue",
      executor: "executeObjectSourceSave",
      sourceKey: "production.sourceObjectSource",
    },
    {
      path: "apps/desktop/src/components/objects/ObjectBrowser.vue",
      executor: "api.executeQuery",
      sourceKey: "production.sourceObjectBrowser",
    },
    {
      path: "apps/desktop/src/components/generate/DataGenerateDialog.vue",
      executor: "api.executeQuery",
      sourceKey: "production.sourceDataGenerate",
    },
    {
      path: "apps/desktop/src/components/editor/QueryHistory.vue",
      executor: "api.executeScript",
      sourceKey: "production.sourceQueryHistory",
    },
    {
      path: "apps/desktop/src/components/admin/DatabaseUserAdmin.vue",
      executor: "api.executeMulti",
      sourceKey: "production.sourceAdmin",
    },
    {
      path: "apps/desktop/src/components/admin/DamengJobAdmin.vue",
      executor: "api.executeMulti",
      sourceKey: "production.sourceAdmin",
    },
  ];

  for (const entrypoint of entrypoints) {
    const source = readSource(entrypoint.path);
    assert.match(source, /executeWithProductionSqlGuard/, entrypoint.path);
    assert.ok(source.includes(entrypoint.executor), `${entrypoint.path} should still execute SQL through its original backend API`);
    assert.ok(source.includes(entrypoint.sourceKey), `${entrypoint.path} should label the confirmation source`);
  }
});

test("object browser batch empty reviews the frozen SQL plan before executing", () => {
  const source = readSource("apps/desktop/src/components/objects/ObjectBrowser.vue");
  const body = functionBody(source, "confirmBatchEmptyTables");
  assert.match(body, /executeObjectBrowserSqlWithProductionGuard\(\s*reviewSql/, "batch empty must use the Object Browser production guard");
  assert.match(body, /runBatchTableEmpty/, "batch empty should still use the batch executor after confirmation");
  assert.ok(body.indexOf("executeObjectBrowserSqlWithProductionGuard") < body.indexOf("runBatchTableEmpty"), "production guard must be entered before the batch executor");
});

test("mongo sidebar mutations share the production-gated runMongoSidebarMutation shell", () => {
  const shellSource = readSource("apps/desktop/src/lib/sidebar/runMongoSidebarMutation.ts");
  assert.match(shellSource, /executeWithProductionContextGuard/, "shared mongo mutation shell must request production confirmation");
  assert.match(shellSource, /return \{\s*result\s*\}/, "void execute success must be boxed so it is not treated as cancel");
  assert.match(shellSource, /if \(executed === undefined\) return/, "only unboxed undefined from the guard means cancel");
  assert.match(shellSource, /onSuccess\(executed\.result\)/, "onSuccess must receive the unboxed execute result");

  const source = readSource("apps/desktop/src/composables/useSidebarDatabaseSpecificMutationRuntime.ts");
  for (const name of [
    "confirmRenameMongoCollection",
    "confirmDropMongoCollection",
    "confirmDropMongoIndex",
    "confirmDropAllMongoIndexes",
    "confirmDropMongoDatabase",
  ] as const) {
    const body = functionBody(source, name);
    assert.match(body, /runMongoSidebarMutation/, `${name} must use the shared mongo mutation shell`);
    assert.ok(body.includes("production.sourceSidebar"), `${name} should label the confirmation source`);
  }

  assert.ok(source.includes("api.mongoRenameCollection"), "mongo rename should still call the rename API");
  assert.ok(source.includes("api.mongoDropDatabase"), "mongo drop database should still call the drop API");

  const dropDatabaseBody = functionBody(readSource("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue"), "confirmDropDatabase");
  assert.match(dropDatabaseBody, /confirmDropMongoDatabase/, "host drop-database confirm should delegate mongo to the mutation runtime");
  assert.ok(!dropDatabaseBody.includes("api.mongoDropDatabase"), "host drop-database confirm should not call mongo APIs directly");
});
