import { EditorSelection } from "@codemirror/state";
import type { EditorView, MouseSelectionStyle } from "@codemirror/view";
import { sqlSemanticDialectFor } from "@/lib/sql/semantic/dialect";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import type { SemanticSelectionRange } from "@/lib/editor/semanticSelectionRanges";
import type { SqlSemanticSelectionOptions } from "@/lib/editor/sqlSemanticSelectionRanges";

export interface QueryEditorParenthesisMouseSelectionOptions extends SqlSemanticSelectionOptions {
  language?: "sql" | "text";
  composing?: boolean;
}

/**
 * Text inside the parenthesis pair that the character at `position` belongs to,
 * or null when that character is not a SQL parenthesis, has no partner, or the
 * pair is empty. Parentheses inside strings, quoted identifiers and comments
 * are not punctuation tokens, so they never pair up with code parentheses.
 *
 * `assoc` follows `EditorView.posAndSideAtCoords`: -1 means the pointer hit the
 * character before `position`, 1 the character after it.
 */
export function sqlParenthesisContentRangeAt(doc: string, position: number, assoc: -1 | 1, options: SqlSemanticSelectionOptions = {}): SemanticSelectionRange | null {
  const character = assoc < 0 ? position - 1 : position;
  if (character < 0 || (doc[character] !== "(" && doc[character] !== ")")) return null;

  const stack: number[] = [];
  for (const token of tokenizeSqlSemantic(doc, sqlSemanticDialectFor(options).id)) {
    if (token.kind !== "punctuation") continue;
    if (token.text === "(") {
      stack.push(token.span.start);
      continue;
    }
    if (token.text !== ")") continue;
    const open = stack.pop();
    if (open === undefined) continue;
    const close = token.span.start;
    if (open !== character && close !== character) continue;
    return open + 1 < close ? { from: open + 1, to: close } : null;
  }
  return null;
}

/**
 * Double-clicking a parenthesis selects the text between it and its partner, so
 * a nested `IN (...)`, `FROM (...)` or `CASE WHEN (...)` can be picked up and
 * replaced without dragging. Anything else keeps the default double-click.
 */
export function createQueryEditorParenthesisMouseSelection(view: EditorView, event: MouseEvent, options: QueryEditorParenthesisMouseSelectionOptions = {}): MouseSelectionStyle | null {
  if (event.button !== 0 || event.detail !== 2 || event.altKey || options.composing || options.language === "text") return null;
  const start = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false);
  const content = sqlParenthesisContentRangeAt(view.state.doc.toString(), start.pos, start.assoc, options);
  if (!content) return null;

  let range = EditorSelection.range(content.from, content.to);
  let startSelection = view.state.selection;
  return {
    update(update) {
      if (!update.docChanged) return;
      range = range.map(update.changes);
      startSelection = startSelection.map(update.changes);
    },
    get(_currentEvent, extend, multiple) {
      if (extend) return startSelection.replaceRange(startSelection.main.extend(range.from, range.to));
      if (multiple) return startSelection.addRange(range);
      return EditorSelection.create([range]);
    },
  };
}
