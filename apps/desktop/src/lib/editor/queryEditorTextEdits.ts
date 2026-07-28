import type { ChangeSpec, EditorState, SelectionRange, Text, TransactionSpec } from "@codemirror/state";

export interface DispatchableEditorView {
  state: EditorState;
  dispatch(spec: TransactionSpec): void;
}

export function replaceSelectedEditorText(view: DispatchableEditorView, insert: string): boolean {
  if (view.state.readOnly) return false;

  const selection = view.state.selection.main;
  if (selection.empty) return false;

  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: { anchor: selection.from + insert.length },
    scrollIntoView: true,
  });
  return true;
}

export function blankLineDeletionChanges(doc: Text, selection: SelectionRange): ChangeSpec[] {
  if (doc.length === 0) return [];

  const hasSelection = !selection.empty;
  const firstLine = hasSelection ? doc.lineAt(selection.from).number : 1;
  const lastSelectedPosition = hasSelection ? Math.max(selection.from, selection.to - 1) : doc.length;
  const lastLine = hasSelection ? doc.lineAt(lastSelectedPosition).number : doc.lines;
  const changes: ChangeSpec[] = [];

  let lineNumber = firstLine;
  while (lineNumber <= lastLine) {
    const line = doc.line(lineNumber);
    if (line.text.trim().length > 0) {
      lineNumber += 1;
      continue;
    }

    const firstBlankLine = line;
    let lastBlankLine = line;
    while (lineNumber < lastLine) {
      const nextLine = doc.line(lineNumber + 1);
      if (nextLine.text.trim().length > 0) break;
      lineNumber += 1;
      lastBlankLine = nextLine;
    }

    // Prefer the following separator so non-empty lines retain their existing newline.
    if (lastBlankLine.to < doc.length) {
      changes.push({ from: firstBlankLine.from, to: lastBlankLine.to + 1 });
    } else if (firstBlankLine.from > 0) {
      changes.push({ from: firstBlankLine.from - 1, to: lastBlankLine.to });
    } else {
      changes.push({ from: 0, to: doc.length });
    }
    lineNumber += 1;
  }

  return changes;
}
