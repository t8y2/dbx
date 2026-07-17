import { strict as assert } from "node:assert";
import { test } from "vitest";
import { createSidebarPasteHandlerRegistry } from "../../apps/desktop/src/lib/sidebar/sidebarPasteHandlerRegistry.ts";

test("unregistering one duplicate owner keeps the other handler active", () => {
  const registry = createSidebarPasteHandlerRegistry();
  const calls: string[] = [];
  const unregisterVirtualRow = registry.register("database-1", () => calls.push("virtual"));
  const unregisterStickyRow = registry.register("database-1", () => calls.push("sticky"));

  assert.equal(registry.request("database-1"), true);
  assert.deepEqual(calls, ["sticky"]);

  unregisterStickyRow();
  assert.equal(registry.request("database-1"), true);
  assert.deepEqual(calls, ["sticky", "virtual"]);

  unregisterVirtualRow();
  assert.equal(registry.request("database-1"), false);
});

test("recycled row cleanup removes only its previous node registration", () => {
  const registry = createSidebarPasteHandlerRegistry();
  const calls: string[] = [];
  const unregisterFirstNode = registry.register("table-1", () => calls.push("first"));

  unregisterFirstNode();
  const unregisterSecondNode = registry.register("table-2", () => calls.push("second"));

  assert.equal(registry.request("table-1"), false);
  assert.equal(registry.request("table-2"), true);
  assert.deepEqual(calls, ["second"]);

  unregisterSecondNode();
});
