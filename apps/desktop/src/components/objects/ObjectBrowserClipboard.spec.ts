import { describe, expect, it } from "vitest";
import objectBrowserSource from "./ObjectBrowser.vue?raw";

describe("ObjectBrowser table clipboard context menu", () => {
  it("resolves recycled row menus when they are opened", () => {
    const lazyMenuBindings = objectBrowserSource.match(/:items="\(\) => getObjectBrowserMenuItems\(item\)"/g);

    expect(lazyMenuBindings).toHaveLength(2);
  });

  it("keeps paste on the copied row and allows replacing it from another row", () => {
    expect(objectBrowserSource).toMatch(/function tableClipboardMenuItems\(item: ObjectBrowserRow\)[\s\S]*?objectBrowserTableClipboardMenuState\(item\)[\s\S]*?state === "copy"[\s\S]*?state === "paste" \? \[pasteItem\] : \[copyItem, pasteItem\]/);
    expect(objectBrowserSource).toContain("...tableClipboardMenuItems(item)");
  });

  it("normalizes copied and target schemas before paste validation", () => {
    expect(objectBrowserSource).toMatch(/function normalizedObjectBrowserTableClipboardEntries\(\)[\s\S]*?normalizeObjectBrowserTableClipboardSchema\(entry\.schema, entry\.database, entry\.connectionId\)/);
    expect(objectBrowserSource).toMatch(/function canPasteTableClipboard\(\)[\s\S]*?tableClipboardMatchesTarget\(normalizedObjectBrowserTableClipboardEntries\(\), pasteTableTargetContext\(\)\)/);
    expect(objectBrowserSource).toMatch(/function pasteTableTargetContext\(\)[\s\S]*?normalizeObjectBrowserTableClipboardSchema\(selectedSchema\.value\)/);
    expect(objectBrowserSource).toMatch(/pasteTableEntries\.value = clipboard\.tables\.map[\s\S]*?normalizeObjectBrowserTableClipboardSchema\(entry\.schema, entry\.database, entry\.connectionId\)/);
    expect(objectBrowserSource).toMatch(/function normalizeObjectBrowserTableClipboardSchema[\s\S]*?connectionStore\.getConfig\(connectionId\) \?\? props\.connection[\s\S]*?!isSchemaAware\(connection\.db_type\)[\s\S]*?connection\.db_type !== "sqlite"[\s\S]*?return undefined/);
  });

  it("consumes only the clipboard used by a fully successful paste", () => {
    expect(objectBrowserSource).toMatch(/async function confirmPasteTable\(\)[\s\S]*?const clipboardAtPasteStart = connectionStore\.treeClipboard[\s\S]*?if \(failCount === 0\)[\s\S]*?connectionStore\.treeClipboard === clipboardAtPasteStart[\s\S]*?connectionStore\.treeClipboard = null/);
  });

  it("refreshes created tables and retains the clipboard when a later paste step is cancelled", () => {
    expect(objectBrowserSource).toMatch(/let pasteCancelled = false[\s\S]*?let hasMutatedTable = false/);
    expect(objectBrowserSource).toMatch(/if \(!executed\) \{[\s\S]*?pasteCancelled = true;[\s\S]*?break;/);
    expect(objectBrowserSource).toMatch(/if \(pasteCancelled\) \{[\s\S]*?if \(hasMutatedTable\)[\s\S]*?await reload\(\)[\s\S]*?refreshObjectListTreeNode[\s\S]*?pasteTableCancelledAfterPartial[\s\S]*?return;/);
  });

  it("carries table comments through local copy and paste", () => {
    expect(objectBrowserSource).toMatch(/tableName: row\.name,\s*tableComment: row\.comment/);
    expect(objectBrowserSource).toMatch(/targetName: `\$\{entry\.tableName\}_copy`,[\s\S]*?tableComment: entry\.tableComment/);
    expect(objectBrowserSource).toMatch(/buildDuplicateStructurePlan\(entry\.sourceName, targetName, schema, entry\.tableComment/);
  });
});
