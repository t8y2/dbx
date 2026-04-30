import { strict as assert } from "node:assert";
import test from "node:test";
import { closeAllTabsState, closeOtherTabsState } from "../src/lib/tabCloseActions.ts";

test("close other tabs keeps the target tab and makes it active", () => {
  const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }];

  const result = closeOtherTabsState(tabs, "a", "b");

  assert.deepEqual(result.tabs.map((tab) => tab.id), ["b"]);
  assert.equal(result.activeTabId, "b");
  assert.deepEqual(tabs.map((tab) => tab.id), ["a", "b", "c"]);
});

test("close other tabs is a no-op when the target tab is missing", () => {
  const tabs = [{ id: "a" }, { id: "b" }];

  const result = closeOtherTabsState(tabs, "a", "missing");

  assert.deepEqual(result.tabs.map((tab) => tab.id), ["a", "b"]);
  assert.equal(result.activeTabId, "a");
});

test("close all tabs clears every tab and active tab", () => {
  const result = closeAllTabsState([{ id: "a" }, { id: "b" }], "a");

  assert.deepEqual(result.tabs, []);
  assert.equal(result.activeTabId, null);
});
