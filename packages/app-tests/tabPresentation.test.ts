import { strict as assert } from "node:assert";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import { shouldShowTabOverflowControls, tabDisplayTitle } from "../../apps/desktop/src/lib/tabPresentation.ts";
import { useConnectionStore } from "../../apps/desktop/src/stores/connectionStore.ts";
import type { ConnectionConfig, QueryTab } from "../../apps/desktop/src/types/database.ts";

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

function conn(id: string): ConnectionConfig {
  return {
    id,
    name: "Prod",
    db_type: "postgres",
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "",
  };
}

function queryTab(overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id: "tab-1",
    title: "Query 1",
    connectionId: "conn-1",
    database: "app",
    sql: "",
    isExecuting: false,
    mode: "query",
    ...overrides,
  };
}

test("tab overflow controls only show when there are hidden tabs to reach", () => {
  assert.equal(shouldShowTabOverflowControls(0, true, true, true), false);
  assert.equal(shouldShowTabOverflowControls(3, false, false, false), false);
  assert.equal(shouldShowTabOverflowControls(3, true, false, false), true);
  assert.equal(shouldShowTabOverflowControls(3, false, true, false), true);
  assert.equal(shouldShowTabOverflowControls(3, false, false, true), true);
});

test("query tab display title uses custom title when present", () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  useConnectionStore().addEphemeralConnection(conn("conn-1"));
  const t = (key: string) => key;

  try {
    assert.equal(tabDisplayTitle(queryTab(), t), "Prod@app");
    assert.equal(tabDisplayTitle(queryTab({ title: "Revenue checks", customTitle: true }), t), "Revenue checks");
  } finally {
    restoreStorage();
  }
});
