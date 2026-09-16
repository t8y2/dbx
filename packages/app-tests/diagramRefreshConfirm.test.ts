import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { describe, test } from "vitest";

const dialogSource = readFileSync(new URL("../../apps/desktop/src/components/diagram/SchemaDiagramDialog.vue", import.meta.url), "utf8");
const toolbarSource = readFileSync(new URL("../../apps/desktop/src/components/diagram/DiagramToolbar.vue", import.meta.url), "utf8");

describe("diagram refresh confirmation wiring", () => {
  test("toolbar emits refresh from the refresh button", () => {
    assert.match(toolbarSource, /@click="emit\('refresh'\)"/);
    assert.match(toolbarSource, /diagram\.refresh/);
  });

  test("dialog opens DangerConfirmDialog before reload", () => {
    assert.match(dialogSource, /function requestRefreshDiagram\(\)/);
    assert.match(dialogSource, /showRefreshConfirm\.value = true/);
    assert.match(dialogSource, /@refresh="requestRefreshDiagram"/);
    assert.match(
      dialogSource,
      /DangerConfirmDialog[^>]*v-model:open="showRefreshConfirm"[^>]*@confirm="confirmRefreshDiagram"/,
    );
    assert.match(dialogSource, /function confirmRefreshDiagram\(\)[\s\S]*?void loadDiagram\(\)/);
  });
});
