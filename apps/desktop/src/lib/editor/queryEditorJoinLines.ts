import type { ChangeSpec, EditorState, Line } from "@codemirror/state";
import type { Command } from "@codemirror/view";

interface LineSpan {
  from: number;
  to: number;
}

function selectedLineSpans(state: EditorState): LineSpan[] {
  const spans: LineSpan[] = [];

  for (const range of state.selection.ranges) {
    const from = state.doc.lineAt(range.from).number;
    let to = state.doc.lineAt(range.to).number;
    if (from === to) {
      if (to === state.doc.lines) continue;
      to++;
    }

    const previous = spans[spans.length - 1];
    if (previous && from <= previous.to) {
      previous.to = Math.max(previous.to, to);
    } else {
      spans.push({ from, to });
    }
  }

  return spans;
}

function firstContentOffset(line: Line): number {
  return line.text.search(/\S/);
}

function contentEnd(line: Line): number {
  return line.to - (line.text.match(/\s*$/)?.[0].length ?? 0);
}

function joinChangesForSpan(state: EditorState, span: LineSpan): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  const firstLine = state.doc.line(span.from);
  let hasContent = firstContentOffset(firstLine) >= 0;
  let separatorFrom = hasContent ? contentEnd(firstLine) : firstLine.from;
  let lastContentLine = hasContent ? span.from : 0;

  for (let lineNumber = span.from + 1; lineNumber <= span.to; lineNumber++) {
    const line = state.doc.line(lineNumber);
    const contentOffset = firstContentOffset(line);
    if (contentOffset < 0) continue;

    changes.push({
      from: separatorFrom,
      to: line.from + contentOffset,
      insert: hasContent ? " " : "",
    });
    hasContent = true;
    separatorFrom = contentEnd(line);
    lastContentLine = lineNumber;
  }

  if (lastContentLine < span.to) {
    const lastLine = state.doc.line(span.to);
    if (separatorFrom < lastLine.to) changes.push({ from: separatorFrom, to: lastLine.to });
  }

  return changes;
}

export const joinQueryEditorLines: Command = ({ state, dispatch }) => {
  if (state.readOnly) return false;

  const changes = selectedLineSpans(state).flatMap((span) => joinChangesForSpan(state, span));
  if (changes.length === 0) return false;

  const changeSet = state.changes(changes);
  dispatch(
    state.update({
      changes: changeSet,
      selection: state.selection.map(changeSet),
      scrollIntoView: true,
      userEvent: "input.joinlines",
    }),
  );
  return true;
};
