import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function read(relativePath: string) {
  return readFileSync(resolve(here, relativePath), "utf8");
}

describe("mongo collection import/export UI", () => {
  it("adds table-style import/export to the original mongo-collection menu", () => {
    const menu = read("../SidebarTreeRuntimeHost.vue");
    const start = menu.indexOf('if (node.type === "mongo-collection") {\n    items.push({ label: t("contextMenu.copyName")');
    expect(start).toBeGreaterThan(-1);
    const end = menu.indexOf("return true;", start);
    const block = menu.slice(start, end);
    expect(block).toContain('t("contextMenu.viewData")');
    expect(block).toContain('t("contextMenu.cloneCollection")');
    expect(block.indexOf('t("contextMenu.cloneCollection")')).toBeLessThan(block.indexOf('t("contextMenu.importData")'));
    expect(block).toContain("openMongoImport");
    expect(block).toContain('t("contextMenu.exportData")');
    expect(block).toContain('exportMongoCollection("csv")');
    expect(block).toContain('exportMongoCollection("ndjson")');
    expect(block).not.toContain("openMongoExport");
  });

  it("opens import through AppDialogs like table import, without an export setup dialog", () => {
    const dialogs = read("../../layout/AppDialogs.vue");
    expect(dialogs).toContain("MongoImportDialog");
    expect(dialogs).not.toContain("MongoExportDialog");
    expect(dialogs).toContain("dialogs.showMongoImportDialog.value");

    const sources = read("../../../composables/useDialogSources.ts");
    expect(sources).toContain("connectionStore.mongoImportSource");
    expect(sources).not.toContain("connectionStore.mongoExportSource");
  });
});
