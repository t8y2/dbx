import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../DatabaseSearchDialog.vue", import.meta.url), "utf8");

describe("DatabaseSearchDialog layout", () => {
  it("keeps the header and footer visible within the dynamic viewport", () => {
    expect(dialogSource).toContain('class="flex max-h-[calc(var(--dbx-viewport-height)-6rem)] min-h-0 max-w-4xl flex-col overflow-hidden gap-0 p-0"');
    expect(dialogSource).toContain('<DialogHeader class="shrink-0 border-b px-5 py-4">');
    expect(dialogSource).toContain('<DialogFooter class="shrink-0 border-t px-5 py-3">');
  });

  it("scrolls the middle region without removing result-list scrolling", () => {
    expect(dialogSource).toContain('class="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4"');
    expect(dialogSource).toContain('class="max-h-[360px] space-y-2 overflow-auto pr-1"');
  });

  it("preserves the footer close action", () => {
    expect(dialogSource).toContain('@click="dialogOpen = false"');
  });
});
