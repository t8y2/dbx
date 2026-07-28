import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { DEFAULT_HBASE_ROW_LIMIT, HBASE_ROW_LIMIT_STORAGE_KEY, loadHBaseRowLimit, normalizeHBaseRowLimit, saveHBaseRowLimit } from "../../apps/desktop/src/lib/hbase/hbaseBrowserPreferences.ts";

function functionBody(source: string, name: string): string {
  const signatureIndex = source.indexOf(`async function ${name}(`);
  assert.notEqual(signatureIndex, -1, `Could not find function ${name}`);
  const bodyStart = source.indexOf("{", signatureIndex);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, index);
    }
  }
  throw new Error(`Could not parse function ${name}`);
}

test("HBase table DDL refreshes the visible object list instead of reusing loaded children", () => {
  const source = readFileSync("apps/desktop/src/components/hbase/HBaseBrowser.vue", "utf8");

  for (const name of ["createTable", "deleteTable"]) {
    const body = functionBody(source, name);
    assert.match(body, /await connectionStore\.refreshObjectListTreeNode\(props\.connectionId, props\.namespace\)/);
    assert.doesNotMatch(body, /connectionStore\.loadTables/);
  }
});

test("HBase grid disables unsupported offset and infinite-scroll pagination", () => {
  const source = readFileSync("apps/desktop/src/components/hbase/HBaseBrowser.vue", "utf8");
  assert.match(source, /<DataGrid[\s\S]*:pagination-enabled="false"/);
});

test("HBase table context menu exposes its REST-backed delete action", () => {
  const source = readFileSync("apps/desktop/src/components/sidebar/SidebarTreeRuntimeHost.vue", "utf8");
  const menuStart = source.indexOf('if (currentDatabaseType() === "hbase" && node.type === "table")');
  const menuEnd = source.indexOf("return true;", menuStart);
  const menu = source.slice(menuStart, menuEnd);

  assert.match(menu, /label: t\("hbase\.deleteTable"\)/);
  assert.match(menu, /action: requestDeleteHBaseTable/);
  assert.match(source, /await api\.hbaseDeleteTable\(node\.connectionId, node\.database, node\.label\)/);
  assert.match(source, /await connectionStore\.refreshObjectListTreeNode\(node\.connectionId, node\.database\)/);
});

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
