import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../SidebarTreeRuntimeHost.vue", import.meta.url), "utf8");

/**
 * Secondary evidence for the connection-node refresh wiring. The primary
 * behavioral coverage lives in connectionStore.refresh.spec.ts and the
 * metadata cache specs; this guards the component-side routing and error
 * classification without mounting the full sidebar tree host.
 */
describe("SidebarTreeRuntimeHost connection refresh cache invalidation", () => {
  it("routes connection-node refresh through the awaited strict store method", () => {
    expect(source).toMatch(/if \(node\.type === "connection" && node\.connectionId\) \{\s*try \{\s*await connectionStore\.refreshConnectionTreeNode\(node\);/);
  });

  it("reports object cache failures distinctly without opening the driver store", () => {
    const connectionBranch = source.slice(source.indexOf("await connectionStore.refreshConnectionTreeNode(node);"), source.indexOf("await connectionStore.refreshTreeNode(node);", source.indexOf("await connectionStore.refreshConnectionTreeNode(node);")));
    const cacheFailureBlock = connectionBranch.match(/if \(isObjectCacheInvalidationError\(e\)\) \{[\s\S]*?\n\s*return;\s*\n/);
    expect(cacheFailureBlock).not.toBeNull();
    expect(cacheFailureBlock![0]).toContain('t("connection.objectCacheRefreshFailed"');
    expect(cacheFailureBlock![0]).not.toContain("openDriverStoreForInstallError");
  });

  it("keeps the regular refresh path and its connection-error handling for other nodes", () => {
    const refresh = source.slice(source.indexOf("async function refresh()"), source.indexOf("async function copyName()"));
    const nonConnection = refresh.slice(refresh.indexOf("await connectionStore.refreshTreeNode(node);"));
    expect(nonConnection).toMatch(/toast\(t\("connection\.connectFailed"/);
    expect(nonConnection).toContain("openDriverStoreForInstallError");
  });
});
