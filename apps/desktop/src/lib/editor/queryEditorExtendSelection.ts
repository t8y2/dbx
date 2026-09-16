import type { Command, EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { matchesShortcut, type ShortcutLikeEvent } from "@/lib/editor/keyboardShortcuts";
import { analyzePlainTextSelectionRanges, nextPlainTextSelectionRange } from "@/lib/editor/plainTextSelectionRanges";
import { chooseNextSemanticSelectionRange, type SemanticSelectionRange } from "@/lib/editor/semanticSelectionRanges";
import { analyzeSqlSemanticSelectionRanges, nextSqlSemanticSelectionRange, type SqlSemanticSelectionOptions } from "@/lib/editor/sqlSemanticSelectionRanges";

export interface QueryEditorExtendSelectionOptions extends SqlSemanticSelectionOptions {
  language?: "sql" | "text";
}

export function extendQueryEditorSelection(view: EditorView, options: QueryEditorExtendSelectionOptions = {}): boolean {
  const doc = view.state.doc.toString();
  const plainTextAnalysis = analyzePlainTextSelectionRanges(doc);
  const sqlAnalysis = options.language === "text" ? null : analyzeSqlSemanticSelectionRanges(doc, options);
  let changed = false;
  const ranges = view.state.selection.ranges.map((range) => {
    const context = {
      doc,
      cursor: range.head,
      current: { from: range.from, to: range.to },
      preferDelimitedContent: options.language !== "text",
    };
    const candidates: SemanticSelectionRange[] = [];
    const plainTextCandidate = nextPlainTextSelectionRange(context, plainTextAnalysis);
    if (plainTextCandidate) candidates.push(plainTextCandidate);
    const sqlCandidate = sqlAnalysis ? nextSqlSemanticSelectionRange(context, options, sqlAnalysis) : null;
    if (sqlCandidate) candidates.push(sqlCandidate);
    const next = chooseNextSemanticSelectionRange(context.current, context.cursor, candidates);
    if (!next) return range;
    changed = true;
    return range.anchor <= range.head ? EditorSelection.range(next.from, next.to) : EditorSelection.range(next.to, next.from);
  });
  if (!changed) return false;
  view.dispatch({ selection: EditorSelection.create(ranges, view.state.selection.mainIndex), scrollIntoView: true });
  return true;
}

export interface PreventableShortcutEvent extends ShortcutLikeEvent {
  preventDefault(): void;
}

export function runQueryEditorAltExtendSelection(event: PreventableShortcutEvent, shortcut: string, view: EditorView, command: Command | null, platform = globalThis.navigator?.platform || ""): boolean {
  if (!command || !event.altKey || event.ctrlKey || event.metaKey) return false;
  if (!matchesShortcut(event, shortcut, platform)) return false;
  if (!command(view)) return false;
  event.preventDefault();
  return true;
}
