import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const objectBrowserSource = readFileSync(new URL("../ObjectBrowser.vue", import.meta.url), "utf8");

describe("ObjectBrowser cross-database table paste", () => {
  it("routes a foreign table clipboard to the shared data-transfer dialog", () => {
    expect(objectBrowserSource).toContain("function canTransferTableClipboard()");
    expect(objectBrowserSource).toContain("function openTransferFromTableClipboard()");
    expect(objectBrowserSource).toContain("targetConnectionId: target.connectionId");
    expect(objectBrowserSource).toContain("targetDatabase: target.database");
    expect(objectBrowserSource).toMatch(/function objectBrowserTableClipboardMenuState[\s\S]*?tableClipboardMenuState\([\s\S]*?canTransferTableClipboard\(\),\s*\)/);
  });

  it("keeps the local duplicate-table paste path available", () => {
    expect(objectBrowserSource).toContain("if (canTransferTableClipboard()) {");
    expect(objectBrowserSource).toContain("if (!canPasteTableClipboard() && !canTransferTableClipboard()) return;");
    expect(objectBrowserSource).toContain("pasteTableMode.value = defaultPasteTableMode(effectiveDatabaseType.value);");
    expect(objectBrowserSource).toContain('normalizeNewTargetName: mode === "structure-and-data"');
  });
});
