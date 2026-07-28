import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../DataTransferDialog.vue", import.meta.url), "utf8");

describe("DataTransferDialog layout", () => {
  it("keeps the header and footer outside the shrinking content region", () => {
    expect(dialogSource).toContain('<DialogHeader class="shrink-0">');
    expect(dialogSource).toContain('<DialogFooter class="shrink-0">');
    expect(dialogSource).toContain('class="min-h-0 flex-1 overflow-hidden"');
  });

  it("shrinks the table row on short viewports without adding dialog scrolling", () => {
    expect(dialogSource).toContain('class="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-4 py-3"');
    expect(dialogSource).toContain('class="flex min-h-0 flex-col gap-2"');
    expect(dialogSource).not.toContain('class="flex-1 min-h-0 overflow-auto"');
  });

  it("keeps long table lists independently scrollable", () => {
    expect(dialogSource).toContain('class="min-h-0 max-h-[200px] overflow-y-auto rounded-md border"');
  });
});
