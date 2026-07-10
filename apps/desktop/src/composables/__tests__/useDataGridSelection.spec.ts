import { computed, ref } from "vue";
import { describe, expect, it } from "vitest";
import { useDataGridSelection } from "@/composables/useDataGridSelection";

function createSelection() {
  const columns = computed(() => ["id", "name", "email"]);
  const displayItems = computed(() =>
    [1, 2, 3, 4].map((id, index) => ({
      id,
      sourceIndex: index,
      data: [id, `name-${id}`, `user-${id}@example.com`],
      isNew: false,
      isDraft: false,
      isDeleted: false,
      isDirtyCol: [false, false, false],
      status: "clean",
    })),
  );

  return useDataGridSelection({
    columns,
    displayItems,
    editingCell: ref(null),
    showTranspose: ref(false),
    transposeRowIndex: ref(null),
    gridRef: ref(undefined),
  });
}

function rowEvent(options: { meta?: boolean; shift?: boolean } = {}): MouseEvent {
  return {
    metaKey: !!options.meta,
    ctrlKey: !!options.meta,
    shiftKey: !!options.shift,
  } as MouseEvent;
}

describe("useDataGridSelection", () => {
  it("creates a whole-row cell range for contiguous meta row selections", () => {
    const selection = createSelection();

    selection.handleRowClick(1, 2, rowEvent({ meta: true }));
    selection.handleRowClick(2, 3, rowEvent({ meta: true }));
    selection.handleRowClick(3, 4, rowEvent({ meta: true }));

    expect(selection.selectedRowIds.value).toEqual(new Set([2, 3, 4]));
    expect(selection.selectedRange.value).toEqual({
      startRow: 1,
      endRow: 3,
      startCol: 0,
      endCol: 2,
    });
    expect(selection.hasCellSelection.value).toBe(true);
  });

  it("does not create a rectangular cell range for non-contiguous meta row selections", () => {
    const selection = createSelection();

    selection.handleRowClick(0, 1, rowEvent({ meta: true }));
    selection.handleRowClick(2, 3, rowEvent({ meta: true }));

    expect(selection.selectedRowIds.value).toEqual(new Set([1, 3]));
    expect(selection.selectedRange.value).toBeNull();
    expect(selection.hasCellSelection.value).toBe(false);
  });
});
