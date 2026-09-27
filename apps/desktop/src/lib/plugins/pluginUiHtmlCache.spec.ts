// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readPluginUiEntry: vi.fn(),
  readPluginUiAsset: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  readPluginUiEntry: mocks.readPluginUiEntry,
  readPluginUiAsset: mocks.readPluginUiAsset,
}));

import { clearPluginUiHtmlCache, getCachedPluginUiHtml, getOrLoadPluginUiHtml, setCachedPluginUiHtml } from "./pluginUiHtmlCache";

function uiEntryPayload(html: string): { dataBase64: string } {
  return { dataBase64: btoa(html) };
}

describe("pluginUiHtmlCache", () => {
  beforeEach(() => {
    clearPluginUiHtmlCache();
    vi.resetAllMocks();
  });

  it("returns the stored document for the same plugin id+version key", () => {
    setCachedPluginUiHtml("io.dbx.ssh@0.4.88", { html: "<html>a</html>", entryDirectory: "" });
    expect(getCachedPluginUiHtml("io.dbx.ssh@0.4.88")).toEqual({ html: "<html>a</html>", entryDirectory: "" });
  });

  it("evicts oldest entries beyond the limit and refreshes on read", () => {
    setCachedPluginUiHtml("k1", { html: "1", entryDirectory: "" });
    setCachedPluginUiHtml("k2", { html: "2", entryDirectory: "" });
    setCachedPluginUiHtml("k3", { html: "3", entryDirectory: "" });
    setCachedPluginUiHtml("k4", { html: "4", entryDirectory: "" });
    // Reading k1 makes it the newest entry.
    expect(getCachedPluginUiHtml("k1")?.html).toBe("1");
    setCachedPluginUiHtml("k5", { html: "5", entryDirectory: "" });
    setCachedPluginUiHtml("k6", { html: "6", entryDirectory: "" });
    // k2/k3 (oldest, untouched) are evicted; k1 survived via the refresh.
    expect(getCachedPluginUiHtml("k1")?.html).toBe("1");
    expect(getCachedPluginUiHtml("k2")).toBeUndefined();
    expect(getCachedPluginUiHtml("k3")).toBeUndefined();
    expect(getCachedPluginUiHtml("k4")?.html).toBe("4");
    expect(getCachedPluginUiHtml("k5")?.html).toBe("5");
    expect(getCachedPluginUiHtml("k6")?.html).toBe("6");
  });

  it("treats a version change as a cache miss", () => {
    setCachedPluginUiHtml("io.dbx.ssh@0.4.88", { html: "old", entryDirectory: "" });
    expect(getCachedPluginUiHtml("io.dbx.ssh@0.4.89")).toBeUndefined();
  });

  it("getOrLoad resolves from the cache without touching the bridge", async () => {
    setCachedPluginUiHtml("io.dbx.ssh@0.4.88", { html: "cached", entryDirectory: "" });
    await expect(getOrLoadPluginUiHtml("io.dbx.ssh@0.4.88", "io.dbx.ssh")).resolves.toEqual({ html: "cached", entryDirectory: "" });
    expect(mocks.readPluginUiEntry).not.toHaveBeenCalled();
  });

  it("coalesces concurrent misses into one pipeline run and caches the document", async () => {
    let release!: (value: { dataBase64: string }) => void;
    mocks.readPluginUiEntry.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const first = getOrLoadPluginUiHtml("io.dbx.ssh@0.4.88", "io.dbx.ssh");
    const second = getOrLoadPluginUiHtml("io.dbx.ssh@0.4.88", "io.dbx.ssh");
    release(uiEntryPayload("<html>doc</html>"));
    await expect(first).resolves.toEqual({ html: "<html>doc</html>", entryDirectory: "" });
    await expect(second).resolves.toEqual({ html: "<html>doc</html>", entryDirectory: "" });
    // One bridge read served both callers (dock warm + panel mount).
    expect(mocks.readPluginUiEntry).toHaveBeenCalledTimes(1);
    // Subsequent callers hit the LRU without a new read.
    await expect(getOrLoadPluginUiHtml("io.dbx.ssh@0.4.88", "io.dbx.ssh")).resolves.toEqual({ html: "<html>doc</html>", entryDirectory: "" });
    expect(mocks.readPluginUiEntry).toHaveBeenCalledTimes(1);
    expect(getCachedPluginUiHtml("io.dbx.ssh@0.4.88")).toEqual({ html: "<html>doc</html>", entryDirectory: "" });
  });

  it("keeps the cache untouched on failure and lets the next caller retry", async () => {
    mocks.readPluginUiEntry.mockRejectedValueOnce(new Error("bridge down"));
    await expect(getOrLoadPluginUiHtml("io.dbx.ssh@0.4.88", "io.dbx.ssh")).rejects.toThrow("bridge down");
    expect(getCachedPluginUiHtml("io.dbx.ssh@0.4.88")).toBeUndefined();
    // The failed in-flight slot is cleared, so a retry re-runs the pipeline.
    mocks.readPluginUiEntry.mockResolvedValueOnce(uiEntryPayload("<html>retry</html>"));
    await expect(getOrLoadPluginUiHtml("io.dbx.ssh@0.4.88", "io.dbx.ssh")).resolves.toEqual({ html: "<html>retry</html>", entryDirectory: "" });
    expect(mocks.readPluginUiEntry).toHaveBeenCalledTimes(2);
  });
});
