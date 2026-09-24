import { beforeEach, describe, expect, it } from "vitest";
import { clearPluginUiHtmlCache, getCachedPluginUiHtml, setCachedPluginUiHtml } from "./pluginUiHtmlCache";

describe("pluginUiHtmlCache", () => {
  beforeEach(() => {
    clearPluginUiHtmlCache();
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
});
