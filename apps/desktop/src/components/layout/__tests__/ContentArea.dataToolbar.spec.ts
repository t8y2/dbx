import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const contentAreaSource = readFileSync(new URL("../ContentArea.vue", import.meta.url), "utf8");

describe("ContentArea data toolbar", () => {
  it("keeps table properties in the primary toolbar at every overflow tier", () => {
    expect(contentAreaSource).toContain('v-if="activeTab.result && activeDataTabTableMeta && activeTab.connectionId"');
    expect(contentAreaSource).not.toContain("showDataTableInfoButton");
    expect(contentAreaSource).not.toContain("ToolbarOverflowMenu");
  });
});
