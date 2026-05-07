import { strict as assert } from "node:assert";
import test from "node:test";
import {
  closeAllTabsState,
  closeLeftTabsState,
  closeOtherTabsState,
  closeRightTabsState,
} from "../src/lib/tabCloseActions.ts";

test("close other tabs keeps the target tab and makes it active", () => {
  const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }];

  const result = closeOtherTabsState(tabs, "a", "b");

  assert.deepEqual(
    result.tabs.map((tab) => tab.id),
    ["b"],
  );
  assert.equal(result.activeTabId, "b");
  assert.deepEqual(
    tabs.map((tab) => tab.id),
    ["a", "b", "c"],
  );
});

test("close other tabs is a no-op when the target tab is missing", () => {
  const tabs = [{ id: "a" }, { id: "b" }];

  const result = closeOtherTabsState(tabs, "a", "missing");

  assert.deepEqual(
    result.tabs.map((tab) => tab.id),
    ["a", "b"],
  );
  assert.equal(result.activeTabId, "a");
});

test("close left tabs keeps target and right side tabs", () => {
  const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  const result = closeLeftTabsState(tabs, "c", "b");

  assert.deepEqual(
    result.tabs.map((tab) => tab.id),
    ["b", "c", "d"],
  );
  assert.equal(result.activeTabId, "c");
  assert.deepEqual(
    tabs.map((tab) => tab.id),
    ["a", "b", "c", "d"],
  );
});

test("close left tabs activates target when current active tab is closed", () => {
  const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  const result = closeLeftTabsState(tabs, "a", "c");

  assert.deepEqual(
    result.tabs.map((tab) => tab.id),
    ["c", "d"],
  );
  assert.equal(result.activeTabId, "c");
});

test("close right tabs keeps target and left side tabs", () => {
  const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  const result = closeRightTabsState(tabs, "b", "c");

  assert.deepEqual(
    result.tabs.map((tab) => tab.id),
    ["a", "b", "c"],
  );
  assert.equal(result.activeTabId, "b");
  assert.deepEqual(
    tabs.map((tab) => tab.id),
    ["a", "b", "c", "d"],
  );
});

test("close right tabs activates target when current active tab is closed", () => {
  const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  const result = closeRightTabsState(tabs, "d", "b");

  assert.deepEqual(
    result.tabs.map((tab) => tab.id),
    ["a", "b"],
  );
  assert.equal(result.activeTabId, "b");
});

test("close left and right tabs are no-ops when the target tab is missing", () => {
  const tabs = [{ id: "a" }, { id: "b" }];

  const leftResult = closeLeftTabsState(tabs, "a", "missing");
  const rightResult = closeRightTabsState(tabs, "a", "missing");

  assert.deepEqual(
    leftResult.tabs.map((tab) => tab.id),
    ["a", "b"],
  );
  assert.equal(leftResult.activeTabId, "a");
  assert.deepEqual(
    rightResult.tabs.map((tab) => tab.id),
    ["a", "b"],
  );
  assert.equal(rightResult.activeTabId, "a");
});

test("close all tabs clears every tab and active tab", () => {
  const result = closeAllTabsState([{ id: "a" }, { id: "b" }], "a");

  assert.deepEqual(result.tabs, []);
  assert.equal(result.activeTabId, null);
});
