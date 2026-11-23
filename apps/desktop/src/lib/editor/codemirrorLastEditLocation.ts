import type { Extension, StateField as StateFieldType, Transaction } from "@codemirror/state";
import type { EditorView as EditorViewType } from "@codemirror/view";

/**
 * Per-document stack of previous edit locations, modelled on the JetBrains
 * "Last Edit Location" action (`Ctrl+Shift+Backspace`) and VS Code's
 * "Go to Last Edit Location".
 *
 * The stack lives in a `StateField`, so it travels with the editor state: the
 * SQL editor reuses one `EditorView` and caches up to 16 `EditorState`s while
 * switching tabs, which gives us per-file behaviour without any extra store.
 * A tab whose cached state has been evicted simply starts with an empty stack.
 *
 * Coalescing rule: a new entry is only pushed when the edit lands on a
 * different line than the current top entry. Without it, typing three
 * characters would push three positions and "jump back" would move one
 * character at a time instead of returning to the previously edited line.
 */
export const LAST_EDIT_LOCATION_LIMIT = 32;

export interface QueryEditorLastEditLocationModules {
  StateField: typeof import("@codemirror/state").StateField;
  StateEffect: typeof import("@codemirror/state").StateEffect;
}

export interface QueryEditorLastEditLocationSnapshot {
  /** Document offsets of recent edits, newest first. */
  positions: readonly number[];
  /** Index the next jump targets; grows past the end and wraps around. */
  cursor: number;
}

export interface QueryEditorLastEditLocations {
  extension: Extension;
  /** Jump to the next older edit location; `false` when the stack is empty. */
  goBack(view: EditorViewType): boolean;
  /** Drop the stack, e.g. after the whole document was replaced. */
  reset(view: EditorViewType): void;
  /** The backing field, for tests that drive raw `EditorState`s. */
  field: StateFieldType<QueryEditorLastEditLocationSnapshot>;
}

const UNDO_REDO_USER_EVENTS = ["undo", "redo", "input.undo", "input.redo"] as const;

const EMPTY_SNAPSHOT: QueryEditorLastEditLocationSnapshot = { positions: [], cursor: 0 };

/**
 * True when the transaction replaces the whole document, which is what
 * `swapEditorDocument` in `useQueryEditorDocumentState` dispatches when the
 * editor moves to another tab. Those offsets do not describe edits the user
 * can return to, so the stack restarts. An empty previous document (initial
 * content load) is treated the same way.
 */
function replacesWholeDocument(transaction: Transaction): boolean {
  const previousLength = transaction.startState.doc.length;
  if (previousLength === 0) return true;
  let whole = false;
  transaction.changes.iterChangedRanges((fromA, toA) => {
    if (fromA === 0 && toA === previousLength) whole = true;
  });
  return whole;
}

function isUndoOrRedo(transaction: Transaction): boolean {
  return UNDO_REDO_USER_EVENTS.some((event) => transaction.isUserEvent(event));
}

function clampToDocument(position: number, length: number): number {
  return Math.min(Math.max(position, 0), length);
}

export function createQueryEditorLastEditLocations(options: { modules: QueryEditorLastEditLocationModules }): QueryEditorLastEditLocations {
  const { StateField, StateEffect } = options.modules;
  const setCursorEffect = StateEffect.define<number>();
  const resetEffect = StateEffect.define<null>();

  const field: StateFieldType<QueryEditorLastEditLocationSnapshot> = StateField.define<QueryEditorLastEditLocationSnapshot>({
    create: () => EMPTY_SNAPSHOT,
    update(snapshot, transaction) {
      let reset = false;
      let cursor: number | undefined;
      for (const effect of transaction.effects) {
        if (effect.is(resetEffect)) reset = true;
        else if (effect.is(setCursorEffect)) cursor = effect.value;
      }
      if (reset) return EMPTY_SNAPSHOT;
      if (!transaction.docChanged) {
        if (cursor === undefined) return snapshot;
        return { positions: snapshot.positions, cursor };
      }
      if (replacesWholeDocument(transaction)) return EMPTY_SNAPSHOT;
      const mapped = snapshot.positions.map((position) => clampToDocument(transaction.changes.mapPos(position, -1), transaction.newDoc.length));
      if (isUndoOrRedo(transaction)) return { positions: mapped, cursor: 0 };
      const editedAt = clampToDocument(transaction.changes.mapPos(transaction.startState.selection.main.head, -1), transaction.newDoc.length);
      const top = mapped[0];
      if (top !== undefined && transaction.newDoc.lineAt(top).number === transaction.newDoc.lineAt(editedAt).number) {
        return { positions: mapped, cursor: 0 };
      }
      return { positions: [editedAt, ...mapped].slice(0, LAST_EDIT_LOCATION_LIMIT), cursor: 0 };
    },
  });

  function goBack(view: EditorViewType): boolean {
    const snapshot = view.state.field(field);
    const total = snapshot.positions.length;
    if (total === 0) return false;
    const index = ((snapshot.cursor % total) + total) % total;
    const anchor = clampToDocument(snapshot.positions[index] ?? 0, view.state.doc.length);
    view.dispatch({
      selection: { anchor },
      scrollIntoView: true,
      userEvent: "select",
      effects: setCursorEffect.of(index + 1),
    });
    return true;
  }

  function reset(view: EditorViewType): void {
    if (view.state.field(field).positions.length === 0) return;
    view.dispatch({ effects: resetEffect.of(null) });
  }

  return { extension: field, goBack, reset, field };
}
