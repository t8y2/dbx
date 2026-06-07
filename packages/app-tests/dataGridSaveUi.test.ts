import { strict as assert } from "node:assert";
import test from "node:test";
import { dataGridSaveActionMode, dataGridSaveToolbarState } from "../../apps/desktop/src/lib/dataGridSaveUi.ts";

test("uses concise save and commit labels for the primary grid save action", () => {
  assert.deepEqual(dataGridSaveActionMode({ pendingChangeCount: 3, useTransaction: true }), {
    labelKey: "grid.commit",
    tooltipKey: "grid.transactionSaveHint",
    secondaryActionKey: "grid.rollback",
  });

  assert.deepEqual(dataGridSaveActionMode({ pendingChangeCount: 3, useTransaction: false }), {
    labelKey: "grid.save",
    tooltipKey: "grid.nonTransactionalSaveHint",
    secondaryActionKey: "grid.discard",
  });
});

test("keeps grid save actions visible for editable grids even without pending changes", () => {
  assert.deepEqual(
    dataGridSaveToolbarState({
      editable: true,
      hasSaveTarget: true,
      hasPendingChanges: false,
      isSaving: false,
    }),
    {
      showActions: true,
      actionsDisabled: true,
    },
  );

  assert.deepEqual(
    dataGridSaveToolbarState({
      editable: true,
      hasSaveTarget: true,
      hasPendingChanges: true,
      isSaving: false,
    }),
    {
      showActions: true,
      actionsDisabled: false,
    },
  );
});

test("hides grid save actions when a grid cannot save edits", () => {
  assert.deepEqual(
    dataGridSaveToolbarState({
      editable: false,
      hasSaveTarget: true,
      hasPendingChanges: false,
      isSaving: false,
    }),
    {
      showActions: false,
      actionsDisabled: true,
    },
  );

  assert.deepEqual(
    dataGridSaveToolbarState({
      editable: true,
      hasSaveTarget: false,
      hasPendingChanges: true,
      isSaving: false,
    }),
    {
      showActions: false,
      actionsDisabled: true,
    },
  );
});
