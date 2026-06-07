import { strict as assert } from "node:assert";
import test from "node:test";
import { computed, ref } from "vue";
import { useDataGridSelection } from "../../apps/desktop/src/composables/useDataGridSelection.ts";

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
