import { EditorSelection, findClusterBreak, type EditorState, type SelectionRange } from "@codemirror/state";
import type { EditorView, MouseSelectionStyle, ViewUpdate } from "@codemirror/view";
import { analyzeSqlSemanticSelectionRanges, sqlStringContentRangeAt, type SqlSemanticSelectionAnalysis, type SqlSemanticSelectionOptions } from "@/lib/editor/sqlSemanticSelectionRanges";

export interface QueryEditorStringMouseSelectionOptions extends SqlSemanticSelectionOptions {
  language?: "sql" | "text";
  composing?: boolean;
}

interface PointerPosition {
  pos: number;
  assoc: -1 | 1;
}

function groupAt(state: EditorState, position: PointerPosition): SelectionRange {
  const line = state.doc.lineAt(position.pos);
  if (line.length === 0) return EditorSelection.cursor(position.pos);
  let bias = position.assoc;
  const linePosition = position.pos - line.from;
  if (linePosition === 0) bias = 1;
  else if (linePosition === line.length) bias = -1;

  let from = linePosition;
  let to = linePosition;
  if (bias < 0) from = findClusterBreak(line.text, linePosition, false);
  else to = findClusterBreak(line.text, linePosition);
  const categorize = state.charCategorizer(position.pos);
  const category = categorize(line.text.slice(from, to));
  while (from > 0) {
    const previous = findClusterBreak(line.text, from, false);
    if (categorize(line.text.slice(previous, from)) !== category) break;
    from = previous;
  }
  while (to < line.length) {
    const next = findClusterBreak(line.text, to);
    if (categorize(line.text.slice(to, next)) !== category) break;
    to = next;
  }
  return EditorSelection.range(from + line.from, to + line.from);
}

function semanticOrDefaultRange(state: EditorState, position: PointerPosition, options: SqlSemanticSelectionOptions, analysis: SqlSemanticSelectionAnalysis): SelectionRange {
  const semantic = sqlStringContentRangeAt(state.doc.toString(), position.pos, position.assoc, options, analysis);
  return semantic ? EditorSelection.range(semantic.from, semantic.to) : groupAt(state, position);
}

export function createQueryEditorStringMouseSelection(view: EditorView, event: MouseEvent, options: QueryEditorStringMouseSelectionOptions = {}): MouseSelectionStyle | null {
  if (event.button !== 0 || event.detail !== 2 || event.altKey || options.composing || options.language === "text") return null;
  let start = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false);
  let analysis = analyzeSqlSemanticSelectionRanges(view.state.doc.toString(), options);
  const semantic = sqlStringContentRangeAt(view.state.doc.toString(), start.pos, start.assoc, options, analysis);
  if (!semantic) return null;

  let startRange = EditorSelection.range(semantic.from, semantic.to);
  let startSelection = view.state.selection;
  return {
    update(update: ViewUpdate) {
      if (!update.docChanged) return;
      start = { pos: update.changes.mapPos(start.pos, start.assoc), assoc: start.assoc };
      startRange = startRange.map(update.changes);
      startSelection = startSelection.map(update.changes);
      analysis = analyzeSqlSemanticSelectionRanges(update.state.doc.toString(), options);
    },
    get(currentEvent, extend, multiple) {
      const current = view.posAndSideAtCoords({ x: currentEvent.clientX, y: currentEvent.clientY }, false);
      let range = start.pos === current.pos ? startRange : semanticOrDefaultRange(view.state, current, options, analysis);
      if (start.pos !== current.pos && !extend) {
        const from = Math.min(startRange.from, range.from);
        const to = Math.max(startRange.to, range.to);
        range = from < range.from ? EditorSelection.range(from, to, undefined, undefined, range.assoc) : EditorSelection.range(to, from, undefined, undefined, range.assoc);
      }
      if (extend) return startSelection.replaceRange(startSelection.main.extend(range.from, range.to, range.assoc));
      if (multiple) return startSelection.addRange(range);
      return EditorSelection.create([range]);
    },
  };
}
