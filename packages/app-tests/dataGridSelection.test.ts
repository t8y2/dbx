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

function createSelectionWithDraftRow() {
  return useDataGridSelection({
    columns: computed(() => ["id", "name"]),
    displayItems: computed(() => [
      {
        id: 0,
        sourceIndex: 0,
        data: [1, "Ada"],
        isNew: false,
        isDeleted: false,
        isDirtyCol: [false, false],
        status: "clean",
      },
      {
        id: Number.MIN_SAFE_INTEGER,
        data: [null, null],
        isNew: false,
        isDraft: true,
        isDeleted: false,
        isDirtyCol: [false, false],
        status: "draft",
      },
    ]),
    editingCell: ref(null),
    showTranspose: ref(false),
    transposeRowIndex: ref(null),
    gridRef: ref(undefined),
  });
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

test("all-cell selection excludes the quick entry draft row from selected data", () => {
  const selection = createSelectionWithDraftRow();

  selection.selectAllCells();

  assert.deepEqual(selection.selectedCells.value, {
    columns: ["id", "name"],
    rows: [[1, "Ada"]],
  });
  assert.equal(selection.selectedCellCount.value, 2);
});

test("column selection excludes the quick entry draft row from selected data", () => {
  const selection = createSelectionWithDraftRow();

  selection.selectColumn(1);

  assert.deepEqual(selection.selectedCells.value, {
    columns: ["name"],
    rows: [["Ada"]],
  });
  assert.equal(selection.selectedCellCount.value, 1);
});

test("discrete draft cell selection is excluded from selected cell count", () => {
  const selection = createSelectionWithDraftRow();

  selection.selectSingleCell(1, 0);
  selection.handleDataCellMousedown(1, 1, Number.MIN_SAFE_INTEGER, mouseEvent({ ctrlKey: true }));

  assert.deepEqual(selection.selectedCells.value, {
    columns: [],
    rows: [],
  });
  assert.equal(selection.selectedCellCount.value, 0);
  assert.equal(selection.hasCellSelection.value, false);
});

test("mixed discrete cell selection counts only real data cells", () => {
  const selection = createSelectionWithDraftRow();

  selection.selectSingleCell(0, 0);
  selection.handleDataCellMousedown(1, 1, Number.MIN_SAFE_INTEGER, mouseEvent({ ctrlKey: true }));

  assert.deepEqual(selection.selectedCells.value, {
    columns: ["id"],
    rows: [[1]],
  });
  assert.equal(selection.selectedCellCount.value, 1);
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
