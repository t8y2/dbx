import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panelSource = readFileSync(new URL("../SqlFilePanel.vue", import.meta.url), "utf8");

describe("SqlFilePanel selection", () => {
  it("uses the shared ordered-list selection behavior", () => {
    expect(panelSource).toContain("orderedListSelectionIntent(event)");
    expect(panelSource).toContain("orderedListRangeAnchorIndex(visibleItems.value");
    expect(panelSource).not.toContain("anchorIndex ?? 0");
  });

  it("does not open or expand rows during modifier selection", () => {
    expect(panelSource).toMatch(/if \(selectionIntent === "range"\)[\s\S]*selectRangeTo\(currentIndex\);[\s\S]*return;/);
    expect(panelSource).toMatch(/if \(selectionIntent === "toggle"\)[\s\S]*selectionAnchorIndex\.value = currentIndex;[\s\S]*return;/);
    expect(panelSource).toMatch(/selectionAnchorIndex\.value = currentIndex;[\s\S]*activate\(\);/);
  });

  it("clears selection when a non-row area is clicked", () => {
    expect(panelSource).toContain('@click="handlePanelClick"');
    expect(panelSource).toContain("[data-sql-file-row='true']");
    expect(panelSource).toContain('data-sql-file-row="true"');
  });
});

describe("SqlFilePanel folder headers", () => {
  it("keeps sticky folder headers opaque while the file list scrolls", () => {
    expect(panelSource).toContain("bg-[color-mix(in_oklab,var(--muted)_10%,var(--background))] sticky top-0");
    expect(panelSource).toContain("hover:bg-[color-mix(in_oklab,var(--accent)_40%,var(--background))]");
    expect(panelSource).not.toContain("bg-muted/10 sticky top-0");
  });
});

describe("SqlFilePanel DBX-managed trash", () => {
  it("uses move-to-trash wording for delete actions and confirmation", () => {
    expect(panelSource).toMatch(/t\("sqlFileTree\.moveToTrash"\), action: \(\) => folder && requestDelete/);
    expect(panelSource).toContain('{{ t("sqlFileTree.moveToTrash") }}</DialogTitle>');
  });

  it("opens the trash dialog and loads entries on demand", () => {
    expect(panelSource).toContain('@click="openTrashDialog"');
    expect(panelSource).toContain("api.listProjectTrashEntries(project.id)");
    expect(panelSource).toContain('t("sqlFileTree.trashLoadFailed"');
  });

  it("restores an entry through the trash API and refreshes the tree", () => {
    expect(panelSource).toContain("api.restoreProjectEntryFromTrash(project.id, entry.id)");
    expect(panelSource).toContain('@click="restoreTrashEntry(entry)"');
    expect(panelSource).toContain('t("sqlFileTree.trashRestored")');
    expect(panelSource).toContain('t("sqlFileTree.restoreFailed"');
  });

  it("empties the trash only after explicit confirmation", () => {
    expect(panelSource).toContain('@click="showEmptyTrashConfirm = true"');
    expect(panelSource).toContain("api.emptyProjectTrash(project.id)");
    expect(panelSource).toContain('t("sqlFileTree.emptyTrashConfirm")');
    expect(panelSource).toContain('t("sqlFileTree.trashEmptyFailed"');
  });
});
