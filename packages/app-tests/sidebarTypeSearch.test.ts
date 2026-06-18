import { strict as assert } from "node:assert";
import { test } from "vitest";
import { sidebarTypeSearchNextQuery } from "../../apps/desktop/src/lib/sidebarTypeSearch.ts";

test("starts sidebar search from printable keys", () => {
  assert.equal(sidebarTypeSearchNextQuery("", { key: "e" }), "e");
  assert.equal(sidebarTypeSearchNextQuery("ec", { key: "m" }), "ecm");
});

test("removes one search character with Backspace", () => {
  assert.equal(sidebarTypeSearchNextQuery("ecm", { key: "Backspace" }), "ec");
  assert.equal(sidebarTypeSearchNextQuery("", { key: "Backspace" }), null);
});

test("ignores shortcuts and non-searchable initial space", () => {
  assert.equal(sidebarTypeSearchNextQuery("", { key: "f", metaKey: true }), null);
  assert.equal(sidebarTypeSearchNextQuery("", { key: "ArrowDown" }), null);
  assert.equal(sidebarTypeSearchNextQuery("", { key: " " }), null);
  assert.equal(sidebarTypeSearchNextQuery("order", { key: " " }), "order ");
});
