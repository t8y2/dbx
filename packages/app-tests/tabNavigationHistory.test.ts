import { strict as assert } from "node:assert";
import { test } from "vitest";
import { createTabNavigationHistory, moveInTabNavigationHistory, recordTabVisit } from "../../apps/desktop/src/lib/tabs/tabNavigationHistory.ts";

test("navigates backward and forward in tab visit order", () => {
  let history = createTabNavigationHistory();
  history = recordTabVisit(history, "A");
  history = recordTabVisit(history, "D");
  history = recordTabVisit(history, "B");
  const openTabs = new Set(["A", "B", "C", "D"]);

  const backToD = moveInTabNavigationHistory(history, -1, openTabs);
  assert.equal(backToD?.tabId, "D");
  history = backToD!.history;

  const backToA = moveInTabNavigationHistory(history, -1, openTabs);
  assert.equal(backToA?.tabId, "A");
  history = backToA!.history;

  const forwardToD = moveInTabNavigationHistory(history, 1, openTabs);
  assert.equal(forwardToD?.tabId, "D");
  history = forwardToD!.history;

  assert.equal(moveInTabNavigationHistory(history, 1, openTabs)?.tabId, "B");
});

test("clears the forward branch after visiting a tab manually", () => {
  let history = createTabNavigationHistory();
  history = recordTabVisit(history, "A");
  history = recordTabVisit(history, "D");
  history = recordTabVisit(history, "B");

  history = moveInTabNavigationHistory(history, -1, new Set(["A", "B", "C", "D"]))!.history;
  history = recordTabVisit(history, "C");

  assert.deepEqual(history, { entries: ["A", "D", "C"], index: 2 });
  assert.equal(moveInTabNavigationHistory(history, 1, new Set(["A", "B", "C", "D"])), null);
});

test("skips closed tabs while navigating", () => {
  let history = createTabNavigationHistory();
  history = recordTabVisit(history, "A");
  history = recordTabVisit(history, "B");
  history = recordTabVisit(history, "C");
  const openTabs = new Set(["A", "C"]);

  const backToA = moveInTabNavigationHistory(history, -1, openTabs);
  assert.equal(backToA?.tabId, "A");
  assert.equal(moveInTabNavigationHistory(backToA!.history, 1, openTabs)?.tabId, "C");
});

test("skips history entries matching the active tab", () => {
  let history = createTabNavigationHistory();
  history = recordTabVisit(history, "A");
  history = recordTabVisit(history, "D");
  history = recordTabVisit(history, "B");
  history = recordTabVisit(history, "D");

  assert.equal(moveInTabNavigationHistory(history, -1, new Set(["A", "D"]), "D")?.tabId, "A");
});
