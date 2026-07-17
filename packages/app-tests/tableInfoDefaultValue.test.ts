import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { tableColumnDefaultDisplayValue } from "@/lib/table/tableColumnDefaultPresentation";

const tableInfoSurfaces = ["apps/desktop/src/components/objects/ObjectBrowser.vue", "apps/desktop/src/components/grid/DataGrid.vue"];

test("table column defaults preserve raw database expressions", () => {
  const values = [null, "''", "0", "CURRENT_TIMESTAMP", "((1))", "('prefix (internal)')", "x".repeat(512)] as const;

  assert.deepEqual(values.map(tableColumnDefaultDisplayValue), ["—", ...values.slice(1)]);
  assert.equal(tableColumnDefaultDisplayValue(undefined), "—");
  assert.equal(tableColumnDefaultDisplayValue(""), "");
});

test("both table information surfaces expose the same default-value column", () => {
  for (const path of tableInfoSurfaces) {
    const source = readFileSync(path, "utf8");
    const { descriptor, errors } = parse(source, { filename: path });
    assert.deepEqual(errors, []);
    assert.ok(descriptor.template);
    const result = compileTemplate({ id: path, filename: path, source: descriptor.template.content });
    assert.deepEqual(result.errors, []);

    assert.match(descriptor.template.content, /t\("structureEditor\.defaultValue"\)/);
    assert.match(descriptor.template.content, /data-table-info-column-default/);
    assert.match(descriptor.template.content, /:title="column\.column_default \?\? undefined"/);
    assert.match(descriptor.template.content, /tableColumnDefaultDisplayValue\(column\.column_default\)/);
  }
});
