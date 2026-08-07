import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const runtimeSource = readFileSync(new URL("../SidebarTreeRuntimeHost.vue", import.meta.url), "utf8");

describe("cross-database table paste", () => {
  it("keeps the live node active after async tree loads", () => {
    expect(runtimeSource).toContain("function emitNodeToggled(node: TreeNode, wasExpanded: boolean, expandedOverride?: boolean)");
    expect(runtimeSource).toContain("findSidebarActionTarget(connectionStore.treeNodes, createSidebarActionTarget(node)) ?? node");
    expect(runtimeSource).toContain("activeNode.value = liveNode");
    expect(runtimeSource).toContain("emitNodeToggled(node, wasExpanded, false)");
    expect(runtimeSource).toMatch(/await connectionStore\.loadMongoDatabases\(node\.connectionId\);[\s\S]*?emitNodeToggled\(node, wasExpanded\)/);
    expect(runtimeSource).toContain("connectionStore.cancelTreeNodeLoad(node.id)");
  });

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
    expect(runtimeSource).toContain('normalizeNewTargetName: mode === "structure-and-data"');
  });

  it("carries table comments through the local sidebar paste path", () => {
    expect(runtimeSource).toMatch(/tableName: node\.label,\s*tableComment: node\.comment/);
    expect(runtimeSource).toMatch(/targetName: `\$\{entry\.tableName\}_copy`,[\s\S]*?tableComment: entry\.tableComment/);
    expect(runtimeSource).toMatch(/targetName,\s*tableComment: entry\.tableComment/);
    expect(runtimeSource).toContain("executeAsScript: duplicateTableStructureRequiresScript(structureSql)");
  });

  it("loads Dameng column comments for sidebar duplicate and paste structure clone", () => {
    expect(runtimeSource).toContain("collectDuplicateTableColumnComments");
    expect(runtimeSource).toContain("async function loadDamengDuplicateColumnComments(");
    expect(runtimeSource).toMatch(/databaseType === "dameng"[\s\S]*?loadDamengDuplicateColumnComments\([\s\S]*?node\.connectionId[\s\S]*?columnComments/);
    expect(runtimeSource).toMatch(/if \(databaseType === "dameng"\) \{[\s\S]*?loadDamengDuplicateColumnComments\([\s\S]*?entry\.connectionId[\s\S]*?columnComments = loaded\.columnComments/);
    expect(runtimeSource).toMatch(/tableComment: node\.comment,\s*columnComments,/);
    expect(runtimeSource).toMatch(/tableComment: entry\.tableComment,\s*columnComments,/);
  });
});
