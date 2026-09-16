import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../DataTransferDialog.vue", import.meta.url), "utf8");

describe("DataTransferDialog layout", () => {
  it("keeps only the main dialog resizable within safe viewport bounds", () => {
    const dialogContentTags = dialogSource.match(/<DialogContent\b[^>]*>/g) ?? [];
    const resizableDialogs = dialogContentTags.filter((tag) => tag.includes(" resize"));

    expect(resizableDialogs).toHaveLength(1);
    expect(resizableDialogs[0]).toContain('class="dbx-transfer-dialog sm:max-w-[1120px] max-h-[80vh] flex flex-col overflow-hidden resize"');
    expect(resizableDialogs[0]).toContain(':style="transferDialogStyle"');
    expect(dialogSource).toContain('width: "min(1120px, calc(100vw - 2rem))"');
    expect(dialogSource).toContain('height: "min(80vh, calc(var(--dbx-viewport-height) - 2rem))"');
    expect(dialogSource).toContain('minWidth: "min(780px, calc(100vw - 2rem))"');
    expect(dialogSource).toContain('minHeight: "min(480px, calc(var(--dbx-viewport-height) - 2rem))"');
    expect(dialogSource).toContain('maxWidth: "calc(100vw - 2rem)"');
    expect(dialogSource).toContain('maxHeight: "calc(var(--dbx-viewport-height) - 2rem)"');
  });

  it("keeps source and target side by side while the dialog changes size", () => {
    expect(dialogSource).toContain('class="grid grid-cols-[1fr_auto_1fr] gap-4 items-start"');
  });

  it("keeps the header and footer outside the shrinking content region", () => {
    expect(dialogSource).toContain('<DialogHeader class="shrink-0">');
    expect(dialogSource).toContain('<DialogFooter class="shrink-0">');
    expect(dialogSource).toContain('class="min-h-0 flex-1 overflow-y-auto pl-4 pr-1 scrollbar-thin"');
  });

  it("allows layout scrolling on short viewports to prevent content clipping", () => {
    expect(dialogSource).toContain('class="flex flex-col gap-5 py-3"');
    expect(dialogSource).toContain('class="flex min-h-0 flex-col gap-2"');
  });

  it("keeps long table lists independently scrollable", () => {
    expect(dialogSource).toContain('class="min-h-0 flex-1"');
  });
});

describe("DataTransferDialog transfer prefill", () => {
  it("accepts source, target, schema, and selected-table prefills", () => {
    expect(dialogSource).toContain("prefillSchema?: string;");
    expect(dialogSource).toContain("prefillTables?: string[];");
    expect(dialogSource).toContain("prefillTargetConnectionId?: string;");
    expect(dialogSource).toContain("prefillTargetDatabase?: string;");
    expect(dialogSource).toContain("prefillTargetSchema?: string;");
  });

  it("keeps only copied tables selected after loading the source list", () => {
    expect(dialogSource).toContain("function applyPendingTableSelection()");
    expect(dialogSource).toContain("new Set(tables.filter((table) => pending.includes(table)))");
  });

  it("sends content and objects in the transfer request", () => {
    expect(dialogSource).toContain("buildTransferObjectSelections(selectedObjects.value, treeDisabledGroups.value)");
    expect(dialogSource).toContain('import { buildTransferObjectSelections } from "./transferSelections"');
    expect(dialogSource).toContain('createTable: transferContent.value !== "dataOnly"');
    expect(dialogSource).toContain('createTable: transferContent.value !== "dataOnly"');
  });

  it("loads non-table object groups per source database kind", () => {
    expect(dialogSource).toContain("transferObjectKindsForDatabase");
    expect(dialogSource).toContain("api.listObjects(connectionId, database, schema, [kind]");
    expect(dialogSource).toContain("groups[kind] = objects.map((o) => o.name)");
  });

  it("routes table-only database kinds through the table-list request", () => {
    expect(dialogSource).toContain("const kinds = transferObjectKindsForDatabase(transferDatabaseTypeForConnection(config))");
    expect(dialogSource).toContain("for (const kind of kinds)");
    expect(dialogSource).toContain('if (kind === "TABLE")');
    expect(dialogSource).toContain("await api.listTables(connectionId, database, schema");
  });

  it("keeps MongoDB collection loading ahead of the generic object-kind path", () => {
    const mongoCollectionBranch = dialogSource.indexOf("if (isMongoConnection(connectionId))");
    const genericObjectKinds = dialogSource.indexOf("const kinds = transferObjectKindsForDatabase(transferDatabaseTypeForConnection(config))");

    expect(mongoCollectionBranch).toBeGreaterThan(-1);
    expect(dialogSource).toContain("await api.mongoListCollections(connectionId, database)");
    expect(mongoCollectionBranch).toBeLessThan(genericObjectKinds);
  });

  it("admits connections via the transfer resolver so doris-family mysql connections stay selectable", () => {
    expect(dialogSource).toContain("supportsTransfer(transferDatabaseTypeForConnection(c))");
    expect(dialogSource).not.toContain("supportsTransfer(effectiveDatabaseTypeForConnection(c))");
  });

  it("disables non-table groups for data-only and cross-family transfers", () => {
    expect(dialogSource).toContain("treeDisabledGroups");
    expect(dialogSource).toContain('transferContent.value === "dataOnly"');
    expect(dialogSource).toContain("crossFamilyTransferableKinds");
    expect(dialogSource).toContain("objectDataOnlyDisabled");
  });

  it("allows a transfer between different schemas in the same database", () => {
    expect(dialogSource).toContain("isSameTransferDatabase");
    expect(dialogSource).toContain("const sameSourceAndTarget = sameCatalogAndDatabase && effectiveSourceSchema === effectiveTargetSchema");
  });

  it("keeps catalog filtering and completion refresh catalog-aware", () => {
    expect(dialogSource).toContain("fetchCatalogNamespaceOptions(connectionId, catalog, config)");
    expect(dialogSource).toContain("store.refreshObjectListTreeNode(request.targetConnectionId, request.targetDatabase, request.targetSchema, request.targetCatalog)");
  });

  it("keeps default tree-schema databases selectable without leaking sentinels", () => {
    expect(dialogSource).toContain("const sourceDatabaseName = computed(() => decodedDatabase(sourceConnectionId.value, sourceDatabase.value))");
    expect(dialogSource).toContain("const targetDatabaseName = computed(() => decodedDatabase(targetConnectionId.value, targetDatabase.value))");
    expect(dialogSource).toContain("sourceDatabase: sourceDatabaseName.value");
    expect(dialogSource).toContain("targetDatabase: targetDatabaseName.value");
    expect(dialogSource).toContain(':display-name="(option) => databaseOptionLabel(sourceConnectionId, option)"');
    expect(dialogSource).toContain(':display-name="(option) => databaseOptionLabel(targetConnectionId, option)"');
  });

  it("discards stale async results after the connection changes", () => {
    // 竞态防护：切换连接后旧请求的回调必须丢弃，不能覆盖新选择的下拉选项
    expect(dialogSource).toContain("if (isStale()) return;");
    expect(dialogSource).toContain("sourceConnectionId.value !== connectionId");
    expect(dialogSource).toContain("targetConnectionId.value !== connectionId");
    expect(dialogSource).toContain("if (sourceConnectionId.value !== id) return;");
    expect(dialogSource).toContain("if (targetConnectionId.value !== id) return;");
  });
});
