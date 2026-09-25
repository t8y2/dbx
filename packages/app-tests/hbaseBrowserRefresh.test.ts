import { strict as assert } from "node:assert";
import { test } from "vitest";
import { DEFAULT_HBASE_ROW_LIMIT, HBASE_ROW_LIMIT_STORAGE_KEY, loadHBaseRowLimit, normalizeHBaseRowLimit, saveHBaseRowLimit } from "../../apps/desktop/src/lib/hbase/hbaseBrowserPreferences.ts";

test("HBase row scan limit is normalized and persisted", () => {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });

  try {
    assert.equal(loadHBaseRowLimit(), DEFAULT_HBASE_ROW_LIMIT);
    assert.equal(normalizeHBaseRowLimit("500"), "500");
    assert.equal(normalizeHBaseRowLimit("999"), DEFAULT_HBASE_ROW_LIMIT);
    assert.equal(saveHBaseRowLimit("200"), "200");
    assert.equal(values.get(HBASE_ROW_LIMIT_STORAGE_KEY), "200");
    assert.equal(loadHBaseRowLimit(), "200");
  } finally {
    if (previousDescriptor) Object.defineProperty(globalThis, "localStorage", previousDescriptor);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});
