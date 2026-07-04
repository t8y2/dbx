import assert from "node:assert/strict";
import { test } from "vitest";
import { buildAllDatabaseExportPlan } from "../../apps/desktop/src/lib/export/databaseExport.ts";

test("all-database export includes every schema for schema-aware databases", () => {
  const plan = buildAllDatabaseExportPlan({
    databases: ["app", "analytics"],
    schemaAware: true,
    schemasByDatabase: {
      app: ["public", "private"],
      analytics: ["reporting"],
    },
  });

  assert.deepEqual(plan, [
    { database: "app", schema: "public", fileStem: "app.public", displayName: "app.public" },
    { database: "app", schema: "private", fileStem: "app.private", displayName: "app.private" },
    { database: "analytics", schema: "reporting", fileStem: "analytics", displayName: "analytics" },
  ]);
});

test("all-database export uses the database as schema for non-schema-aware databases", () => {
  const plan = buildAllDatabaseExportPlan({
    databases: ["app", "analytics"],
    schemaAware: false,
    schemasByDatabase: {
      app: ["ignored"],
    },
  });

  assert.deepEqual(plan, [
    { database: "app", schema: "app", fileStem: "app", displayName: "app" },
    { database: "analytics", schema: "analytics", fileStem: "analytics", displayName: "analytics" },
  ]);
});
