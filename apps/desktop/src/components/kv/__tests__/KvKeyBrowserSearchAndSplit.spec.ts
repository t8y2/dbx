import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const browserSource = readFileSync(new URL("../KvKeyBrowser.vue", import.meta.url), "utf8");

describe("KvKeyBrowser search and split layout", () => {
  it("uses the requested prefix for a server-side, paginated search", () => {
    expect(browserSource).toContain("props.api.listPrefix(connectionId, searchQuery, pageSize, reset ? null : continuation.value");
    expect(browserSource).not.toContain("async function searchAllKeys");
    expect(browserSource).not.toContain("filterKvKeysBySearch(result.keys, query)");
  });

  it("uses a persisted draggable split between the Key tree and details", () => {
    expect(browserSource).toContain('<Splitpanes class="kv-browser-splitpanes min-h-0 flex-1" @resized="handleKvBrowserSplitResized">');
    expect(browserSource).toContain('<Pane :size="kvBrowserSplitSize" min-size="20" max-size="70">');
    expect(browserSource).toContain('<Pane :size="100 - kvBrowserSplitSize" min-size="30">');
    expect(browserSource).toContain("safeLocalStorageSet(kvBrowserSplitSizeStorageKey, String(size))");
    expect(browserSource).toContain("cursor: col-resize");
  });
});
