import assert from "node:assert/strict";
import { test } from "vitest";
import type { ConnectionConfig } from "../../apps/desktop/src/types/database.ts";
import { sidebarVisibleFilterSummary } from "../../apps/desktop/src/lib/sidebar/sidebarVisibleFilterSummary.ts";

function connection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "connection-1",
    name: "Connection",
    db_type: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
    ...overrides,
  };
}

test("summary remains actionable before primary namespace metadata is loaded", () => {
  assert.deepEqual(sidebarVisibleFilterSummary(connection({ visible_databases: ["app"] })), {
    mode: "database",
    isExplicit: true,
    selected: null,
    total: null,
  });
});

test("unfiltered database summary uses the picker's default non-system scope", () => {
  assert.deepEqual(sidebarVisibleFilterSummary(connection(), ["app", "analytics", "mysql", "sys"]), {
    mode: "database",
    isExplicit: false,
    selected: 2,
    total: 2,
  });
});

test("explicit database summary ignores stale names and retains the default denominator", () => {
  assert.deepEqual(sidebarVisibleFilterSummary(connection({ visible_databases: ["app", "removed"] }), ["app", "analytics", "mysql"]), {
    mode: "database",
    isExplicit: true,
    selected: 1,
    total: 2,
  });
});

test("selecting a system database expands the denominator like the picker", () => {
  assert.deepEqual(sidebarVisibleFilterSummary(connection({ visible_databases: ["app", "mysql"] }), ["app", "analytics", "mysql", "sys"]), {
    mode: "database",
    isExplicit: true,
    selected: 2,
    total: 4,
  });
});

test("schema-mode summary reads the primary schema filter for the configured database", () => {
  assert.deepEqual(
    sidebarVisibleFilterSummary(
      connection({
        db_type: "oracle",
        database: "ORCL",
        username: "APP",
        visible_schemas: { ORCL: ["APP"] },
      }),
      ["APP", "REPORTING", "SYS"],
    ),
    {
      mode: "schema",
      isExplicit: true,
      selected: 1,
      total: 2,
    },
  );
});

test("schema-mode summary includes system schemas when they are explicitly selected", () => {
  assert.deepEqual(
    sidebarVisibleFilterSummary(
      connection({
        db_type: "oracle",
        database: "ORCL",
        username: "APP",
        visible_schemas: { ORCL: ["APP", "SYS"] },
      }),
      ["APP", "REPORTING", "SYS"],
    ),
    {
      mode: "schema",
      isExplicit: true,
      selected: 2,
      total: 3,
    },
  );
});
