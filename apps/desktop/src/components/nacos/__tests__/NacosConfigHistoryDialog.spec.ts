import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../NacosConfigHistoryDialog.vue", import.meta.url), "utf8");

describe("NacosConfigHistoryDialog", () => {
  it("keeps configuration identity values compact while allowing long values to wrap", () => {
    expect(source).toContain('class="mt-1.5 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground"');
    expect(source).toContain('<span class="break-all text-foreground">{{ namespaceLabel }}</span>');
    expect(source).toContain('<span class="break-all text-foreground">{{ dataIdLabel }}</span>');
    expect(source).toContain('<span class="break-all text-foreground">{{ groupLabel }}</span>');
    expect(source).toContain(':title="`namespace=${namespaceLabel}`"');
    expect(source).toContain(':title="`dataId=${dataIdLabel}`"');
    expect(source).toContain(':title="`group=${groupLabel}`"');
    expect(source).not.toContain("grid-cols-1 gap-1.5 text-xs sm:grid-cols-2 xl:grid-cols-3");
    expect(source).not.toContain("h-auto w-full");
    expect(source).not.toContain('class="max-w-64 truncate font-mono"');
    expect(source).not.toContain('class="max-w-72 truncate font-mono"');
    expect(source).not.toContain('class="max-w-48 truncate font-mono"');
  });
});
