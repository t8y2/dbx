import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { compileScript, parse } from "vue/compiler-sfc";

function compiledDataGridScript(): string {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  const { descriptor } = parse(source, { filename: "DataGrid.vue" });
  return compileScript(descriptor, { id: "data-grid-props-test" }).content;
}

test("DataGrid template components have local or documented global bindings", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  const { descriptor } = parse(source, { filename: "DataGrid.vue" });
  const bindings = compileScript(descriptor, { id: "data-grid-component-bindings" }).bindings;
  assert.ok(descriptor.template);

  const globalComponents = new Set(["RecycleScroller"]);
  const componentTags = new Set(Array.from(descriptor.template.content.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g), (match) => match[1]));
  for (const tag of componentTags) {
    assert.ok(bindings[tag] || globalComponents.has(tag), `DataGrid template component ${tag} must be imported or explicitly registered globally`);
  }
});

test("row action limit props default to undefined when omitted", () => {
  const compiled = compiledDataGridScript();

  // Vue Boolean props normally cast an absent prop to false. DataGrid callers
  // omit these props to mean "not restricted", so the runtime default matters.
  assert.match(compiled, /allowInsertRows:\s*\{\s*type:\s*Boolean,\s*required:\s*false,\s*default:\s*undefined\s*\}/);
  assert.match(compiled, /allowDeleteRows:\s*\{\s*type:\s*Boolean,\s*required:\s*false,\s*default:\s*undefined\s*\}/);
});
