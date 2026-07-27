import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const browserSource = readFileSync(new URL("../KvKeyBrowser.vue", import.meta.url), "utf8");

describe("KvKeyBrowser TTL details", () => {
  it("renders the selected key TTL and refreshes it every second", () => {
    expect(browserSource).toContain("const selectedTtlLabel = computed");
    expect(browserSource).toContain('<Badge v-if="selectedTtlLabel" variant="outline">TTL {{ selectedTtlLabel }}</Badge>');
    expect(browserSource).toContain("metadataRefreshTimer = setInterval");
    expect(browserSource).toContain("void refreshSelectedMetadata(key, generation)");
  });

  it("stops TTL polling when the browser unmounts", () => {
    expect(browserSource).toContain("onBeforeUnmount(() =>");
    expect(browserSource).toContain("stopKeyListRefresh()");
    expect(browserSource).toContain("stopMetadataRefresh()");
  });
});
