import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const browserSource = readFileSync(new URL("../KvKeyBrowser.vue", import.meta.url), "utf8");

describe("KvKeyBrowser edit dialog layout", () => {
  it("keeps the value format label and selector together in the editor toolbar", () => {
    expect(browserSource).toContain('class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"');
    expect(browserSource).toContain('class="flex shrink-0 items-center gap-3"');
    expect(browserSource).toContain('<SelectTrigger class="h-9 w-44">');
  });

  it("cancels the shared footer negative margin and preserves bottom safe spacing", () => {
    expect(browserSource).toContain('<DialogFooter class="mx-0 mb-0 shrink-0 gap-3 border-t bg-muted/10 px-6 py-5">');
    expect(browserSource).toContain('variant="outline" class="h-10 min-w-20"');
    expect(browserSource).toContain('<Button class="h-10 min-w-20" :disabled="saving || readOnly"');
  });

  it("applies the same safe spacing to the history dialog footer", () => {
    expect(browserSource).toContain('<DialogFooter class="mx-0 mb-0 shrink-0 border-t px-6 py-5">');
    expect(browserSource).toContain('class="h-10 min-w-20" @click="showHistoryDialog = false"');
  });
});
