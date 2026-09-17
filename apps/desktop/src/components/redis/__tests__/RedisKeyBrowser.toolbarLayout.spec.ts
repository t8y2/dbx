import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// jsdom cannot lay out flex/grid or evaluate container queries, so the #9356
// overlap fix is guarded at the source level: the toolbar actions group must
// wrap (a nowrap + justify-end row spills LEFT onto the search-mode segmented
// control when the key pane is ~320px..730px wide), and the batch-expiry label
// must collapse to an icon before the row reaches that overflow band.
const source = readFileSync(new URL("../RedisKeyBrowser.vue", import.meta.url), "utf8");

function styleRule(selector: string): string {
  // Anchor on a line-start selector so template `class="..."` occurrences never match.
  const start = source.indexOf(`\n${selector} {`);
  expect(start).toBeGreaterThan(-1);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(open + 1, close);
}

describe("redis key browser toolbar layout (#9356)", () => {
  it("lets the toolbar actions wrap instead of overflowing onto the search-mode group", () => {
    expect(styleRule(".redis-key-toolbar-actions")).toContain("flex-wrap: wrap");
  });

  it("collapses the batch-expiry label to an icon in a 740px container tier", () => {
    const tierStart = source.indexOf("@container (max-width: 740px)");
    const tierEnd = source.indexOf("@container (max-width: 340px)");
    expect(tierStart).toBeGreaterThan(-1);
    expect(tierEnd).toBeGreaterThan(tierStart);
    const tierBody = source.slice(tierStart, tierEnd);
    expect(tierBody).toContain(".redis-expiry-label");
    expect(tierBody).toContain(".redis-expiry-icon");
  });

  it("switches to two toolbar rows in the 340px container tier", () => {
    const tierStart = source.indexOf("@container (max-width: 340px)");
    const tierEnd = source.indexOf("@container (max-width: 240px)");
    expect(tierStart).toBeGreaterThan(-1);
    expect(tierEnd).toBeGreaterThan(tierStart);
    const tierBody = source.slice(tierStart, tierEnd);
    expect(tierBody).toContain("grid-template-columns: auto minmax(0, 1fr)");
    const actionsRule = tierBody.slice(tierBody.indexOf(".redis-key-toolbar-actions"));
    expect(actionsRule).toContain("grid-row: 2");
    expect(actionsRule).toContain("justify-content: flex-start");
  });

  it("marks the batch-expiry icon and label in the template", () => {
    expect(source).toMatch(/class="[^"]*redis-expiry-icon[^"]*"/);
    expect(source).toMatch(/<span class="redis-expiry-label">/);
    expect(source).toContain(`:aria-label="t('redis.batchExpiry')"`);
  });

  it("keeps the key pane at a 360px minimum width", () => {
    expect(source).toContain("min-width: min(360px, 64%)");
  });
});
