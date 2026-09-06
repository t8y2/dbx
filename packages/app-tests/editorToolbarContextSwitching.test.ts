import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const appPath = "apps/desktop/src/App.vue";
const contractPath = "apps/desktop/src/components/layout/editorToolbarActions.ts";

// App.vue 是根组件，测试无法挂载；而这族回归（#8218，同 #8216）恰恰是
// 「契约 tabId-first、实现 value-first」的 string/string 参数错位，结构化
// 类型检查对此不可见，所以这里用源码钉住契约两侧的参数顺序。
function functionSource(name: string): string {
  const source = readFileSync(appPath, "utf8");
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `App.vue should define ${name}`);
  const relativeEnd = source.slice(start).search(/\n(?:async\s+)?function\s+[A-Za-z]/);
  return source.slice(start, relativeEnd > 0 ? start + relativeEnd : undefined);
}

test("toolbar context switchers resolve the acting tab from their first parameter (#8218)", () => {
  const signatures: Array<[name: string, expected: RegExp]> = [
    ["changeActiveConnection", /^function changeActiveConnection\(tabId: string, connectionId: string\)/],
    ["changeActiveDatabase", /^function changeActiveDatabase\(tabId: string, database: string\)/],
    ["changeActiveCatalog", /^function changeActiveCatalog\(tabId: string, catalog: string \| undefined, database: string\)/],
    ["changeActiveSchema", /^function changeActiveSchema\(tabId: string, schema: string \| undefined\)/],
  ];
  for (const [name, expected] of signatures) {
    const body = functionSource(name);
    assert.match(body, expected);
    assert.match(body, /resolveToolbarTab\(tabId\)/);
  }
});

test("App provides the switchers directly so the injected contract order reaches them", () => {
  const appSource = readFileSync(appPath, "utf8");
  for (const name of ["changeConnection", "changeCatalog", "changeDatabase", "changeSchema"]) {
    assert.match(appSource, new RegExp(`${name}: changeActive[A-Za-z]+,`));
  }
});

test("the injected toolbar action contract keeps tab id as the first parameter", () => {
  const contract = readFileSync(contractPath, "utf8");
  assert.match(contract, /changeConnection\(tabId: string, connectionId: string\)/);
  assert.match(contract, /changeCatalog\(tabId: string, catalog: string \| undefined, database: string\)/);
  assert.match(contract, /changeDatabase\(tabId: string, database: string\)/);
  assert.match(contract, /changeSchema\(tabId: string, schema: string \| undefined\)/);
});
