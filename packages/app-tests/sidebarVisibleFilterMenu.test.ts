import assert from "node:assert/strict";
import { test } from "vitest";
import { connectionCanConfigureSidebarVisibleDatabases, sidebarConnectionVisibleFilterMenu } from "../../apps/desktop/src/lib/sidebar/sidebarVisibleFilterMenu.ts";

test("connection-level visible filter support preserves the existing sidebar capability boundary", () => {
  assert.equal(connectionCanConfigureSidebarVisibleDatabases("mysql"), true);
  assert.equal(connectionCanConfigureSidebarVisibleDatabases("oracle"), true);
  assert.equal(connectionCanConfigureSidebarVisibleDatabases("redis"), true);
  assert.equal(connectionCanConfigureSidebarVisibleDatabases("sqlite"), true);
  assert.equal(connectionCanConfigureSidebarVisibleDatabases("doris"), false);
  assert.equal(connectionCanConfigureSidebarVisibleDatabases("starrocks"), false);
  assert.equal(connectionCanConfigureSidebarVisibleDatabases("turso"), false);
  assert.equal(connectionCanConfigureSidebarVisibleDatabases("zookeeper"), false);
  assert.equal(connectionCanConfigureSidebarVisibleDatabases("elasticsearch"), false);
  assert.equal(connectionCanConfigureSidebarVisibleDatabases("mq"), false);
  assert.equal(connectionCanConfigureSidebarVisibleDatabases(undefined), false);
});

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
