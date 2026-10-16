import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { describe, test } from "vitest";

const panelSource = readFileSync(new URL("../../apps/desktop/src/components/diagram/SchemaDiagramPanel.vue", import.meta.url), "utf8");
const toolbarSource = readFileSync(new URL("../../apps/desktop/src/components/diagram/DiagramToolbar.vue", import.meta.url), "utf8");

describe("diagram refresh confirmation wiring", () => {
  test("toolbar emits refresh from the refresh button", () => {
    assert.match(toolbarSource, /@click="emit\('refresh'\)"/);
    assert.match(toolbarSource, /diagram\.refresh/);
  });

  test("panel opens DangerConfirmDialog before reload", () => {
    assert.match(panelSource, /function requestRefreshDiagram\(\)/);
    assert.match(panelSource, /showRefreshConfirm\.value = true/);
    assert.match(panelSource, /@refresh="requestRefreshDiagram"/);
    assert.match(
      panelSource,
      /DangerConfirmDialog[^>]*v-model:open="showRefreshConfirm"[^>]*@confirm="confirmRefreshDiagram"/,
    );
    assert.match(panelSource, /function confirmRefreshDiagram\(\)[\s\S]*?void loadDiagram\(\)/);
  });
});
