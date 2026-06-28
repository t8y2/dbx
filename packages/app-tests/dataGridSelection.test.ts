import { strict as assert } from "node:assert";
import { test } from "vitest";
import { computed, ref } from "vue";
import { useDataGridSelection } from "../../apps/desktop/src/composables/useDataGridSelection.ts";

function createSelection() {
  return useDataGridSelection({
    columns: computed(() => ["id", "name", "note"]),
    displayItems: computed(() => [
      {
        id: 0,
        sourceIndex: 0,
        data: [1, "Ada", "math"],
        isNew: false,
        isDeleted: false,
        isDirtyCol: [false, false, false],
        status: "clean",
      },
      {
        id: 1,
        sourceIndex: 1,
        data: [2, "Bob", "quote"],
        isNew: false,
        isDeleted: false,
        isDirtyCol: [false, false, false],
        status: "clean",
      },
      {
        id: 2,
        sourceIndex: 2,
        data: [3, "O'Hara", null],
        isNew: false,
        isDeleted: false,
        isDirtyCol: [false, false, false],
        status: "clean",
      },
    ]),
    editingCell: ref(null),
    showTranspose: ref(false),
    transposeRowIndex: ref(null),
    gridRef: ref(undefined),
  });
}

function mouseEvent(options: Partial<MouseEvent> = {}): MouseEvent {
  return {
    button: 0,
    preventDefault() {},
    ...options,
  } as MouseEvent;
}

test("cell selection does not read row data before a range exists", () => {
  let displayItemsReads = 0;
  const selection = useDataGridSelection({
    columns: computed(() => ["id", "name"]),
    displayItems: computed(() => {
      displayItemsReads += 1;
      return [
        {
          id: 0,
          sourceIndex: 0,
          data: [1, "Ada"],
          isNew: false,
          isDeleted: false,
          isDirtyCol: [false, false],
          status: "clean",
        },
      ];
    }),
    editingCell: ref(null),
    showTranspose: ref(false),
    transposeRowIndex: ref(null),
    gridRef: ref(undefined),
  });

  assert.equal(selection.hasCellSelection.value, false);
  assert.equal(displayItemsReads, 0);
});

test("ctrl clicking cells toggles only the clicked cells", () => {
  const selection = createSelection();

  selection.selectSingleCell(0, 0);
  selection.handleDataCellMousedown(2, 2, 2, mouseEvent({ ctrlKey: true }));

  assert.equal(selection.cellIsSelected(0, 0), true);
  assert.equal(selection.cellIsSelected(2, 2), true);
  assert.equal(selection.cellIsSelected(1, 1), false);
  assert.equal(selection.selectedCellCount.value, 2);
});

test("shift clicking cells keeps range selection", () => {
  const selection = createSelection();

  selection.selectSingleCell(0, 0);
  selection.handleDataCellMousedown(2, 2, 2, mouseEvent({ shiftKey: true }));

  assert.equal(selection.cellIsSelected(0, 0), true);
  assert.equal(selection.cellIsSelected(1, 1), true);
  assert.equal(selection.cellIsSelected(2, 2), true);
  assert.equal(selection.selectedCellCount.value, 9);
});
