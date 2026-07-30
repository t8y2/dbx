import assert from "node:assert/strict";
import { test } from "vitest";
import { sidebarConnectionVisibleFilterMenu } from "../../apps/desktop/src/lib/sidebar/sidebarVisibleFilterMenu.ts";

test("Dameng and Oracle schema-mode filters keep the connection-level dialog with one schema label", () => {
  assert.deepEqual(
    sidebarConnectionVisibleFilterMenu({
      canConfigureVisibleDatabases: true,
      canConfigureVisibleSchemas: true,
      databaseFilterUsesSchemas: true,
    }),
    [{ label: "schemas", target: "visible-databases" }],
  );
});

test("connections with independent database and schema filters retain both entries", () => {
  assert.deepEqual(
    sidebarConnectionVisibleFilterMenu({
      canConfigureVisibleDatabases: true,
      canConfigureVisibleSchemas: true,
      databaseFilterUsesSchemas: false,
    }),
    [
      { label: "objects", target: "visible-databases" },
      { label: "schemas", target: "visible-schemas" },
    ],
  );
});

test("schema-mode database dialog does not depend on a dedicated schema action", () => {
  assert.deepEqual(
    sidebarConnectionVisibleFilterMenu({
      canConfigureVisibleDatabases: true,
      canConfigureVisibleSchemas: false,
      databaseFilterUsesSchemas: true,
    }),
    [{ label: "schemas", target: "visible-databases" }],
  );
});

test("schema-only connections produce one schema menu entry", () => {
  assert.deepEqual(
    sidebarConnectionVisibleFilterMenu({
      canConfigureVisibleDatabases: false,
      canConfigureVisibleSchemas: true,
      databaseFilterUsesSchemas: false,
    }),
    [{ label: "schemas", target: "visible-schemas" }],
  );
});
