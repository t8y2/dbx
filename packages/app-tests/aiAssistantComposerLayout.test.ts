import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { compileTemplate, parse } from "vue/compiler-sfc";

const aiAssistantPath = fileURLToPath(new URL("../../apps/desktop/src/components/editor/AiAssistant.vue", import.meta.url));
const zhCnLocalePath = fileURLToPath(new URL("../../apps/desktop/src/i18n/locales/zh-CN.ts", import.meta.url));
const source = readFileSync(aiAssistantPath, "utf8");
const zhCnLocaleSource = readFileSync(zhCnLocalePath, "utf8");

test("AI composer keeps templates available without connections", () => {
  const contextRowStart = source.indexOf('<div class="flex items-center gap-1 mb-1 text-xs text-foreground/80">');
  const contextRowEnd = source.indexOf('v-if="mentionOpen"', contextRowStart);
  const contextRow = source.slice(contextRowStart, contextRowEnd);

  assert.notEqual(contextRowStart, -1, "the composer context row should exist");
  assert.notEqual(contextRowEnd, -1, "the connection context row should end before mention suggestions");
  assert.match(contextRow, /<template v-if="connectionStore\.connections\.length">/);
  assert.match(contextRow, /<Popover v-model:open="showTemplateSelector">/);
  assert.match(contextRow, /max-w-\[40%\]/);
  assert.match(contextRow, /<span class="truncate">\{\{ templateSelectorTriggerLabel \}\}<\/span>/);
  assert.match(contextRow, /:aria-label="templateSelectorTriggerLabel"/);
});

test("AI composer labels an empty template selection explicitly", () => {
  assert.match(source, /const templateSelectorTriggerLabel = computed\(\(\) => \{[\s\S]*?templateSelectorLabel.*templateSelectorLabel\.value/);
  assert.match(zhCnLocaleSource, /templateSelectorNone: "未选择"/);
});

test("AI composer exposes mode and action as one compact selector", () => {
  const footerStart = source.indexOf('<!-- Combined mode + action selector -->');
  const footerEnd = source.indexOf('<!-- Combined provider + model selector -->', footerStart);
  const footer = source.slice(footerStart, footerEnd);

  assert.notEqual(footerStart, -1, "the combined mode and action selector should exist");
  assert.notEqual(footerEnd, -1, "the model selector should follow the combined selector");
  assert.match(footer, /<Popover v-model:open="modeActionOpen">/);
  assert.match(footer, /:aria-label="modeActionTriggerLabel"/);
  assert.match(footer, /switchModeActionTab\('ask'\)/);
  assert.match(footer, /switchModeActionTab\('agent'\)/);
  assert.match(footer, /selectModeActionItem\(button\.action\)/);
  assert.doesNotMatch(footer, /selectAction\(button\.action\)/);
  assert.match(footer, /<template v-if="showActionButtons">[\s\S]*?<div class="border-t my-1" \/>[\s\S]*?v-for="button in actionButtons"/);
  assert.match(source, /function selectModeActionItem\(action: AiAction\) \{\s*\/\/ Vector databases[\s\S]*?if \(!showActionButtons\.value\) return;/);
});

test("AI composer template remains compilable", () => {
  const { descriptor, errors } = parse(source, { filename: aiAssistantPath });
  assert.deepEqual(errors, []);
  assert.ok(descriptor.template);

  const result = compileTemplate({ id: aiAssistantPath, filename: aiAssistantPath, source: descriptor.template.content });
  assert.deepEqual(result.errors, []);
});
