import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { compileTemplate, parse } from "vue/compiler-sfc";

const contentAreaPath = "apps/desktop/src/components/layout/ContentArea.vue";

function dataModeTemplate(): string {
  const source = readFileSync(contentAreaPath, "utf8");
  const { descriptor, errors } = parse(source, { filename: contentAreaPath });
  assert.deepEqual(errors, []);
  assert.ok(descriptor.template);
  const result = compileTemplate({ id: contentAreaPath, filename: contentAreaPath, source: descriptor.template.content });
  assert.deepEqual(result.errors, []);

  const start = descriptor.template.content.indexOf("activeTab.mode === 'data'");
  const end = descriptor.template.content.indexOf("activeTab.mode === 'redis'", start);
  assert.ok(start >= 0 && end > start, "ContentArea should keep a bounded data-mode template");
  return descriptor.template.content.slice(start, end);
}

test("data tab header shows the active connection before the table context", () => {
  const template = dataModeTemplate();
  const connectionIndex = template.indexOf("data-data-header-connection");
  const tableIndex = template.indexOf("activeTab.tableMeta?.tableName");

  assert.ok(connectionIndex >= 0 && connectionIndex < tableIndex);
  assert.match(template, /v-if="activeConnection\?\.name\?\.trim\(\)"/);
  assert.match(template, /:title="activeConnection\.name"/);
  assert.match(template, /data-data-header-connection class="[^"]*max-w-48[^"]*truncate/);
});
