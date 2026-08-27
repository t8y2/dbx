import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const searchableSelectSource = readFileSync(new URL("../../../components/ui/searchable-select/SearchableSelect.vue", import.meta.url), "utf8");
const dataTransferDialogSource = readFileSync(new URL("../../../components/transfer/DataTransferDialog.vue", import.meta.url), "utf8");
const editorToolbarSource = readFileSync(new URL("../../../components/layout/EditorToolbar.vue", import.meta.url), "utf8");

describe("SearchableSelect layout", () => {
  it("keeps slotted option labels inside a shrinkable overflow boundary", () => {
    const labelBoundaries = searchableSelectSource.match(/dbx-searchable-select-option-label min-w-0 flex-1 overflow-hidden/g) ?? [];

    expect(labelBoundaries).toHaveLength(3);
  });

  it("can preserve custom option whitespace for exact database identifiers", () => {
    expect(searchableSelectSource).toContain("trimCustom?: boolean");
    expect(searchableSelectSource).toContain("trimCustom: true");
    expect(searchableSelectSource).toContain("props.trimCustom ? searchText.value.trim() : searchText.value");
  });

  it("renders data transfer connection pickers as sidebar-like trees", () => {
    const treeSelects = dataTransferDialogSource.match(/<ConnectionTreeSelect/g) ?? [];

    expect(treeSelects).toHaveLength(2);
    expect(dataTransferDialogSource).toContain(':layout="store.sidebarLayout"');
    expect(dataTransferDialogSource).not.toContain("ConnectionGroupBadge");
  });

  it("renders the toolbar connection picker as a sidebar-like tree", () => {
    expect(editorToolbarSource).toContain("<ConnectionTreeSelect");
    expect(editorToolbarSource).toContain(':connections="connectionStore.connections"');
    expect(editorToolbarSource).toContain(':layout="connectionStore.sidebarLayout"');
  });
});
