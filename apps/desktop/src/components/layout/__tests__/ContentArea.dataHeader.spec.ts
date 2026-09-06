import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const contentAreaSource = readFileSync(new URL("../ContentArea.vue", import.meta.url), "utf8");

describe("ContentArea data-mode header", () => {
  it("lets name chips flex to available width and only truncate when the row overflows", () => {
    const headerIndex = contentAreaSource.indexOf("data-data-header-connection");
    expect(headerIndex).toBeGreaterThan(-1);
    const chipsBlock = contentAreaSource.slice(headerIndex, contentAreaSource.indexOf('class="ml-auto"', headerIndex));
    expect(chipsBlock.length).toBeGreaterThan(0);

    // Fixed max-w-48/max-w-56 caps clipped table names even with plenty of free
    // space in the header row (#7880); chips must rely on truncate so they only
    // clip when the row itself runs out of space. The min-w-12 floor keeps
    // scrollWidth reporting real overflow for the measured condensation tiers —
    // below the floor the tiers condense the row instead of crushing chips.
    expect(chipsBlock).not.toContain("max-w-48");
    expect(chipsBlock).not.toContain("max-w-56");
    expect(chipsBlock).toContain("inline-flex min-w-12 items-center truncate");
  });

  it("keeps the full table and schema names reachable via title tooltips", () => {
    expect(contentAreaSource).toContain(':title="activeDataTabTableMeta?.tableName || activeTab.title"');
    expect(contentAreaSource).toContain("[activeDataTabTableMeta?.schema, databaseDisplayNameForTab(activeTab.connectionId, activeTab.database, t)].filter(Boolean).join('@')");
  });
});
