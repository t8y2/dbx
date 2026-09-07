import { strict as assert } from "node:assert";
import { test } from "vitest";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { history, redo, undo, redoDepth, undoDepth } from "@codemirror/commands";

/**
 * Mirrors the tab-switch document swap in QueryEditor.vue (swapEditorDocument).
 * One editor instance serves every tab, so the swap must not leave the previous
 * tab's edits in the undo history. The swap transaction is annotated
 * addToHistory:false, and the history extension is dropped and re-added in two
 * separate transactions — a single compartment reconfigure would carry the old
 * field value over, but a field absent from the intermediate configuration is
 * re-initialized empty.
 */
const historyComp = new Compartment();

function createState(doc: string) {
  return EditorState.create({ doc, extensions: [historyComp.of(history())] });
}

function type(state: EditorState, insert: string, at = state.doc.length) {
  return state.update({ changes: { from: at, to: at, insert }, userEvent: "input.type" }).state;
}

function replaceDocument(state: EditorState, doc: string, { isolateHistory }: { isolateHistory: boolean }) {
  let next = state.update({
    changes: { from: 0, to: state.doc.length, insert: doc },
    ...(isolateHistory ? { annotations: Transaction.addToHistory.of(false) } : {}),
  }).state;
  if (isolateHistory) {
    next = next.update({ effects: historyComp.reconfigure([]) }).state.update({ effects: historyComp.reconfigure(history()) }).state;
  }
  return next;
}

function runUndo(state: EditorState) {
  let next = state;
  const applied = undo({ state, dispatch: (tr) => (next = tr.state) });
  return { applied, state: next };
}

test("plain document swap leaks tab 1's history into tab 2 (the regression)", () => {
  let state = createState("");
  state = type(state, "select 1"); // tab 1 edits
  state = replaceDocument(state, "select 2", { isolateHistory: false }); // switch to tab 2 without isolation

  assert.ok(undoDepth(state) >= 1, "the swap and tab 1's edits stay in the shared history");

  // Undoing inside tab 2 walks back through tab 1's states.
  let current = state;
  for (let guard = 0; guard < 10; guard++) {
    const result = runUndo(current);
    if (!result.applied) break;
    current = result.state;
  }
  assert.equal(current.doc.toString(), "", "undoing in tab 2 reaches tab 1's original document");
});

test("tab swap resets the undo history so undo stays within the active tab", () => {
  let state = createState("");
  state = type(state, "select 1");
  state = replaceDocument(state, "select 2", { isolateHistory: true });

  assert.equal(undoDepth(state), 0, "previous tab's edits must not remain undoable");
  assert.equal(redoDepth(state), 0, "the swap itself must not be redoable");

  const { applied, state: after } = runUndo(state);

  assert.equal(applied, false, "undo should be a no-op");
  assert.equal(after.doc.toString(), "select 2", "document must stay tab 2's content");
});

test("typing after a tab swap is undoable back to the swapped document only", () => {
  let state = createState("");
  state = type(state, "select 1");
  state = replaceDocument(state, "select 2", { isolateHistory: true });
  state = type(state, " 3");

  const first = runUndo(state);
  assert.equal(first.state.doc.toString(), "select 2", "undo removes only this tab's typing");

  const second = runUndo(first.state);
  assert.equal(second.applied, false, "no further undo steps exist");
  assert.equal(second.state.doc.toString(), "select 2", "undo cannot reach tab 1's content");
});

test("same-tab external replacement stays undoable", () => {
  let state = createState("select 1");
  // Formats and similar in-tab rewrites go through a plain dispatch (no tabId change).
  state = state.update({ changes: { from: 0, to: state.doc.length, insert: "select\n  1" } }).state;

  const { applied, state: after } = runUndo(state);

  assert.equal(applied, true, "external in-tab rewrites remain undoable");
  assert.equal(after.doc.toString(), "select 1");
});

test("redo after a tab swap cannot resurrect the previous tab's content", () => {
  let state = createState("");
  state = type(state, "select 1");
  state = replaceDocument(state, "select 2", { isolateHistory: true });
  state = type(state, " 3");
  state = runUndo(state).state;

  let next = state;
  const applied = redo({ state, dispatch: (tr) => (next = tr.state) });

  assert.equal(applied, true, "redo reapplies this tab's typing");
  assert.equal(next.doc.toString(), "select 2 3", "redo stays within tab 2's own edits");
});

test("undo history survives switching away and back (cached per-tab state)", () => {
  // Tab 1 types, its editor state is cached on switch, and reinstated on return.
  let tab1 = createState("");
  tab1 = type(tab1, "select 1");
  const cachedTab1 = tab1;
  assert.equal(undoDepth(cachedTab1), 1, "tab 1 has its own undo step while away");

  // Meanwhile tab 2 is active and edits its own document.
  let tab2 = replaceDocument(cachedTab1, "select 2", { isolateHistory: true });
  tab2 = type(tab2, " 3");
  assert.equal(tab2.doc.toString(), "select 2 3");

  // Switch back to tab 1: the restored state still undoes tab 1's own edit only.
  const restored = runUndo(cachedTab1);
  assert.equal(restored.applied, true, "undo still works after the round trip");
  assert.equal(restored.state.doc.toString(), "", "undo replays only tab 1's history");
});
