import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const runtimeSource = readFileSync(new URL("../SidebarTreeRuntimeHost.vue", import.meta.url), "utf8");

describe("cross-database table paste", () => {
  it("routes a table clipboard from another context to data transfer", () => {
    expect(runtimeSource).toContain("function canTransferTreeClipboardToCurrentNode()");
    expect(runtimeSource).toContain("function openTransferFromTreeClipboard()");
    expect(runtimeSource).toContain("targetConnectionId: target.connectionId");
    expect(runtimeSource).toContain("targetDatabase: target.database");
    expect(runtimeSource).toContain("tables: clipboard.tables.map((entry) => entry.tableName)");
    expect(runtimeSource).toMatch(/function treeTableClipboardMenuItems[\s\S]*?tableClipboardMenuState\([\s\S]*?canTransferTreeClipboardToCurrentNode\(\),\s*\)/);
  });

  it("retains the local duplicate-table paste path", () => {
    expect(runtimeSource).toContain("if (canTransferTreeClipboardToCurrentNode()) return openTransferFromTreeClipboard();");
    expect(runtimeSource).toContain("pasteTableMode.value = defaultPasteTableMode(currentDatabaseType());");
  });
});
