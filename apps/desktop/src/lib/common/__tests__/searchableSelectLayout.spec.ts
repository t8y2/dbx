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

  it("truncates long data transfer connection labels without shrinking their icons", () => {
    const truncatedConnectionLabels = dataTransferDialogSource.match(/<span class="min-w-0 flex-1 truncate">\{\{ label \}\}<\/span>/g) ?? [];
    const fixedConnectionIcons = dataTransferDialogSource.match(/class="h-3\.5 w-3\.5 shrink-0"/g) ?? [];

    expect(truncatedConnectionLabels).toHaveLength(2);
    expect(fixedConnectionIcons).toHaveLength(2);
  });

  it("wraps deep connection group paths without hiding connection names", () => {
    expect(editorToolbarSource).toContain('item-class="min-h-9 h-auto py-1"');
    expect(editorToolbarSource).toMatch(/<span class="[^"]*max-w-48[^"]*shrink-0[^"]*whitespace-normal[^"]*break-words[^"]*">\s*\{\{ connectionGroupLabel\(option\) \}\}\s*<\/span>/);
    expect(editorToolbarSource).toContain('<TruncatedTextTooltip :text="label" class="block min-w-[7rem] flex-1 text-sm font-medium"');
    expect(editorToolbarSource).not.toContain('<TruncatedTextTooltip :text="connectionGroupLabel(option)"');
  });
});
