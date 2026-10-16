// Regression tests for upstream issue t8y2/dbx#12478 (P0):
// 「当重命名查询标签和对象名或表名一致的时候会导致对象或库名改变」
// With the shipped-default compactTabTitle=true a data tab is titled by its
// bare table name and an objects tab by the bare database name. Renaming a
// query tab onto one of those names used to drag the non-renameable object tab
// into the collision group, which minted a numeric suffix INTO the object tab
// (users → users 1) and the suffix stuck even after the query tab was closed.
//
// Fix: syncTabTitleNumbers numbers only the query tabs of a mixed-mode group,
// so renaming a query tab can never retitle a table / objects tab.
import { strict as assert } from "node:assert";
import { afterEach, test } from "vitest";
import { createPinia, disposePinia, getActivePinia, setActivePinia } from "pinia";
import { useConnectionStore } from "../../apps/desktop/src/stores/connectionStore.ts";
import { useQueryStore } from "../../apps/desktop/src/stores/queryStore.ts";
import { useSettingsStore } from "../../apps/desktop/src/stores/settingsStore.ts";
import { syncTabTitleNumbers, tabDisplayTitles } from "../../apps/desktop/src/lib/tabs/tabPresentation.ts";
import type { ConnectionConfig } from "../../apps/desktop/src/types/database.ts";

const translate = (key: string) => ({ "editor.noDatabase": "No database" })[key] ?? key;

function installMemoryStorage() {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  };
}

function setupStore() {
  installMemoryStorage();
  setActivePinia(createPinia());
  const connections = useConnectionStore();
  connections.connections = [{ id: "conn-1", name: "PostgreSQL", db_type: "postgres", host: "localhost", port: 5432, username: "postgres", password: "" } as ConnectionConfig];
  useSettingsStore().editorSettings.compactTabTitle = true; // shipped default (#12310)
  return useQueryStore();
}

function withTableMeta(store: ReturnType<typeof useQueryStore>, tabId: string, tableName: string) {
  const tab = store.tabs.find((item) => item.id === tabId)!;
  (tab as unknown as { tableMeta: { tableName: string } }).tableMeta = { tableName };
}

// Tab labels as the tab strip renders them: base title + numeric suffix.
const stripTitles = (store: ReturnType<typeof useQueryStore>) => {
  syncTabTitleNumbers(store.tabs, translate);
  return tabDisplayTitles(store.tabs, translate);
};

afterEach(() => {
  const pinia = getActivePinia();
  if (pinia) disposePinia(pinia);
  setActivePinia(undefined);
});

test("renaming a query tab to a table name keeps the table tab's name", () => {
  const store = setupStore();
  const dataTabId = store.createTab("conn-1", "mydb", "users", "data");
  const queryTabId = store.createTab("conn-1", "mydb");
  withTableMeta(store, dataTabId, "users");

  assert.equal(stripTitles(store).get(dataTabId), "users", 'baseline: table tab is titled "users"');

  // The user renames the QUERY tab to the same name as the table:
  assert.equal(store.renameTab(queryTabId, "users"), true);
  assert.equal(stripTitles(store).get(dataTabId), "users", "the table tab's name must not change when a query tab is renamed onto it");
});

test("renaming a query tab to the database name keeps the objects tab's name", () => {
  const store = setupStore();
  const objectsTabId = store.createTab("conn-1", "mydb", "mydb", "objects");
  const queryTabId = store.createTab("conn-1", "mydb");

  assert.equal(stripTitles(store).get(objectsTabId), "mydb", 'baseline: objects tab is titled "mydb"');

  assert.equal(store.renameTab(queryTabId, "mydb"), true);
  assert.equal(stripTitles(store).get(objectsTabId), "mydb", "the objects tab's name must not change when a query tab is renamed onto it");
});

test("same-mode collisions still get numbers", () => {
  const store = setupStore();
  const firstId = store.createTab("conn-1", "mydb");
  const secondId = store.createTab("conn-1", "mydb", undefined, "query", undefined, undefined, undefined, { forceNew: true });
  store.renameTab(firstId, "report");
  store.renameTab(secondId, "report");

  const titles = stripTitles(store);
  assert.equal(titles.get(firstId), "report 1", "query/query collisions keep their distinguishable numbers");
  assert.equal(titles.get(secondId), "report 2");
});

test("the table tab's name is not mutated even after the query tab is closed", () => {
  const store = setupStore();
  const dataTabId = store.createTab("conn-1", "mydb", "users", "data");
  const queryTabId = store.createTab("conn-1", "mydb");
  withTableMeta(store, dataTabId, "users");

  store.renameTab(queryTabId, "users");
  stripTitles(store);
  store.closeTab(queryTabId);

  assert.equal(stripTitles(store).get(dataTabId), "users", "the table tab keeps its plain name");
});
