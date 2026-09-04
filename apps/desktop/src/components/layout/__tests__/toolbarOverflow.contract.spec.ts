import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const contentAreaSource = readFileSync(new URL("../ContentArea.vue", import.meta.url), "utf8");
const databaseBrowserSource = readFileSync(new URL("../../objects/DatabaseBrowser.vue", import.meta.url), "utf8");
const objectBrowserSource = readFileSync(new URL("../../objects/ObjectBrowser.vue", import.meta.url), "utf8");
const overflowMenuSource = readFileSync(new URL("../../../components/ui/ToolbarOverflowMenu.vue", import.meta.url), "utf8");

describe("measured toolbar condensation wiring (non-SQL toolbars)", () => {
  it("keeps the overflow trigger a single-layer dropdown (no Tooltip nesting)", () => {
    expect(overflowMenuSource).toContain("DropdownMenuTrigger as-child");
    expect(overflowMenuSource).not.toContain("TooltipTrigger");
    expect(overflowMenuSource).not.toContain("LightTooltip");
  });

  it("condenses the data-mode header row through measured tiers", () => {
    expect(contentAreaSource).toContain("useToolbarOverflow(dataToolbarRef");
    // Chips keep a min-width floor so scrollWidth reports real overflow.
    expect(contentAreaSource).toContain("inline-flex min-w-12 items-center truncate");
    expect(contentAreaSource).toContain('ref="dataToolbarRef"');
    expect(contentAreaSource).toContain("showDataColumnsChip");
    expect(contentAreaSource).toContain("showDataTableInfoButton");
    expect(contentAreaSource).toContain("dataToolbarCompact");
    expect(contentAreaSource).toContain('v-if="showDataToolbarOverflow"');
  });

  it("condenses the database browser header row through measured tiers", () => {
    expect(databaseBrowserSource).toContain("useToolbarOverflow(toolbarRef");
    expect(databaseBrowserSource).toContain('ref="toolbarRef"');
    expect(databaseBrowserSource).toContain("showInlineSortAndView");
    expect(databaseBrowserSource).toContain("showConnectionChip");
    expect(databaseBrowserSource).toContain('v-if="showToolbarOverflow"');
  });

  it("condenses the object browser header row through measured tiers", () => {
    expect(objectBrowserSource).toContain("useToolbarOverflow(toolbarRef");
    expect(objectBrowserSource).toContain('ref="toolbarRef"');
    expect(objectBrowserSource).toContain("showInlineSortAndView");
    expect(objectBrowserSource).toContain("showInlineCheckboxToggle");
    expect(objectBrowserSource).toContain("showInlineObjectFilter");
    expect(objectBrowserSource).toContain("showDatabaseChip");
    expect(objectBrowserSource).toContain('v-if="showToolbarOverflow"');
  });
});
