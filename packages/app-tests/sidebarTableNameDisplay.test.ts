import { test } from "vitest";
import assert from "node:assert/strict";
import { normalizeSidebarHiddenTablePrefixes, sidebarDisplayTableName } from "../../apps/desktop/src/lib/sidebarTableNameDisplay.ts";

test("normalizes sidebar hidden table prefixes", () => {
  assert.deepEqual(normalizeSidebarHiddenTablePrefixes([" app_", "app_", "", "ods."]), ["app_", "ods."]);
  assert.deepEqual(normalizeSidebarHiddenTablePrefixes("app_\nods.\n app_ "), ["app_", "ods."]);
  assert.deepEqual(normalizeSidebarHiddenTablePrefixes(null), []);
});

test("hides a configured table prefix from the sidebar label", () => {
  assert.equal(sidebarDisplayTableName("t8y2_long_customer_order", ["t8y2_long_"]), "...customer_order");
});

test("uses the longest matching sidebar table prefix", () => {
  assert.equal(sidebarDisplayTableName("app_sales_orders", ["app_", "app_sales_"]), "...orders");
});

test("keeps the full name when hiding would leave an empty label", () => {
  assert.equal(sidebarDisplayTableName("app_", ["app_"]), "app_");
});
