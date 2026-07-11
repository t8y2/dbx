import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "vitest";

function readSource(path: string): string {
  return readFileSync(path, "utf8");
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
      path: "apps/desktop/src/components/sidebar/TreeItem.vue",
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
