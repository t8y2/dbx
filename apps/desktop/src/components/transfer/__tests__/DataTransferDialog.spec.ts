import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../DataTransferDialog.vue", import.meta.url), "utf8");

describe("DataTransferDialog layout", () => {
  it("keeps the header and footer outside the shrinking content region", () => {
    expect(dialogSource).toContain('<DialogHeader class="shrink-0">');
    expect(dialogSource).toContain('<DialogFooter class="shrink-0">');
    expect(dialogSource).toContain('class="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-thin"');
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
    expect(dialogSource).toContain("api.listObjects(sourceConnectionId.value, sourceDatabase.value, schema, [kind]");
    expect(dialogSource).toContain("groups[kind] = objects.map((o) => o.name)");
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
});
