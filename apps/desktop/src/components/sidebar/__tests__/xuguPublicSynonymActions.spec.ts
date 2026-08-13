import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runtimeSource = readFileSync(fileURLToPath(new URL("../SidebarTreeRuntimeHost.vue", import.meta.url)), "utf8");

function functionSource(name: string): string {
  const start = runtimeSource.indexOf(`function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = runtimeSource.indexOf("\nfunction ", start + 1);
  return runtimeSource.slice(start, next === -1 ? undefined : next);
}

describe("Xugu public synonym actions", () => {
  it("returns a read-only schema menu before default and destructive actions", () => {
    const menu = functionSource("buildDatabaseSidebarMenu");
    const readOnlyGuard = menu.indexOf("isXuguPublicSynonymTreeNode");

    expect(readOnlyGuard).toBeGreaterThan(-1);
    expect(readOnlyGuard).toBeLessThan(menu.indexOf("contextMenu.setDefaultSchema"));
    expect(readOnlyGuard).toBeLessThan(menu.indexOf("contextMenu.dropSchema"));
  });

  it("guards both the drop request and confirmed execution", () => {
    expect(functionSource("dropSchema")).toContain("isXuguPublicSynonymTreeNode");
    expect(functionSource("confirmDropSchema")).toContain("isXuguPublicSynonymTreeNode");
  });
});
