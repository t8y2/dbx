import { strict as assert } from "node:assert";
import { test } from "vitest";

import { buildGetSchemaCommentSql, buildSetSchemaCommentSql, supportsSchemaComment } from "../../apps/desktop/src/lib/database/dbAdminSql.ts";

test("postgres schema comment SQL quotes identifiers and literals", () => {
  assert.equal(supportsSchemaComment("postgres"), true);
  assert.equal(supportsSchemaComment("mysql"), false);
  assert.equal(buildSetSchemaCommentSql({ databaseType: "postgres", name: 'tenant"one', comment: "Owner's area" }), `COMMENT ON SCHEMA "tenant""one" IS 'Owner''s area';`);
});

test("postgres schema comment SQL clears blank comments", () => {
  assert.equal(buildSetSchemaCommentSql({ databaseType: "postgres", name: "analytics", comment: "  " }), `COMMENT ON SCHEMA "analytics" IS NULL;`);
});

test("postgres schema comment lookup uses pg_namespace description join", () => {
  const sql = buildGetSchemaCommentSql({ databaseType: "postgres", name: "tenant's schema" });

  assert.match(sql, /FROM pg_catalog\.pg_namespace n/);
  assert.match(sql, /pg_catalog\.pg_description d/);
  assert.match(sql, /d\.classoid = 'pg_namespace'::regclass/);
  assert.match(sql, /WHERE n\.nspname = 'tenant''s schema';/);
});
