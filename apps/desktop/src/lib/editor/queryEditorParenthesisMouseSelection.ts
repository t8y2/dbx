import { EditorSelection } from "@codemirror/state";
import type { EditorView, MouseSelectionStyle } from "@codemirror/view";
import { sqlSemanticDialectFor } from "@/lib/sql/semantic/dialect";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import type { SqlSemanticToken } from "@/lib/sql/semantic/types";
import type { SemanticSelectionRange } from "@/lib/editor/semanticSelectionRanges";
import type { SqlSemanticSelectionOptions } from "@/lib/editor/sqlSemanticSelectionRanges";

export interface QueryEditorParenthesisMouseSelectionOptions extends SqlSemanticSelectionOptions {
  language?: "sql" | "text";
  composing?: boolean;
}

const CLOSING_BRACKET_BY_OPENING: Readonly<Record<string, string>> = {
  "(": ")",
  "[": "]",
  "{": "}",
};

const OPENING_BRACKET_BY_CLOSING: Readonly<Record<string, string>> = {
  ")": "(",
  "]": "[",
  "}": "{",
};

function isBracketCharacter(character: string | undefined): character is "(" | ")" | "[" | "]" | "{" | "}" {
  return character !== undefined && (character in CLOSING_BRACKET_BY_OPENING || character in OPENING_BRACKET_BY_CLOSING);
}

function isCodeBracketToken(token: SqlSemanticToken): boolean {
  if (token.kind === "punctuation") return token.text === "(" || token.text === ")" || token.text === "[" || token.text === "]";
  if (token.kind === "operator") return token.text === "{" || token.text === "}";
  return false;
}

/**
 * Text inside the bracket pair (`()`, `[]`, or `{}`) that the character at
 * `position` belongs to, or null when that character is not a SQL bracket, has
 * no partner, or the pair is empty. Brackets inside strings, quoted identifiers
 * and comments are ignored (except dialect-native `[...]` quoted identifiers in
 * SQL Server / SQLite, whose outer brackets select the identifier text).
 *
 * `assoc` follows `EditorView.posAndSideAtCoords`: -1 means the pointer hit the
 * character before `position`, 1 the character after it.
 */
export function sqlParenthesisContentRangeAt(doc: string, position: number, assoc: -1 | 1, options: SqlSemanticSelectionOptions = {}): SemanticSelectionRange | null {
  const character = assoc < 0 ? position - 1 : position;
  if (character < 0 || !isBracketCharacter(doc[character])) return null;

  const dialect = sqlSemanticDialectFor(options);
  const bracketQuotedIdentifiers = dialect.identifierQuotes.some((quote) => quote.open === "[" && quote.close === "]");
  const mysqlFamily = dialect.id === "mysql" || dialect.id === "doris";
  const tokens = tokenizeSqlSemantic(doc, dialect.id, {
    squareBracketsAsDelimiters: !bracketQuotedIdentifiers,
    mysqlBackslashEscape: mysqlFamily,
    mysqlDashCommentRequiresWhitespace: mysqlFamily,
  });

  const stack: Array<{ open: string; start: number }> = [];
  for (const token of tokens) {
    if (bracketQuotedIdentifiers && token.kind === "quoted_identifier" && token.quote === "[" && token.closed !== false) {
      const open = token.span.start;
      const close = token.span.end - 1;
      if (open === character || close === character) return open + 1 < close ? { from: open + 1, to: close } : null;
      continue;
    }
    if (!isCodeBracketToken(token)) continue;
    if (token.text in CLOSING_BRACKET_BY_OPENING) {
      stack.push({ open: token.text, start: token.span.start });
      continue;
    }
    const expectedOpen = OPENING_BRACKET_BY_CLOSING[token.text];
    if (!expectedOpen || stack[stack.length - 1]?.open !== expectedOpen) continue;
    const opening = stack.pop();
    if (!opening) continue;
    const close = token.span.start;
    if (opening.start !== character && close !== character) continue;
    return opening.start + 1 < close ? { from: opening.start + 1, to: close } : null;
  }
  return null;
}

/**
 * Double-clicking a bracket (`(`, `)`, `[`, `]`, `{`, or `}`) selects the text
 * between it and its partner, so nested `IN (...)`, `FROM (...)`, `array[a + b]`
 * or `object{a: 1}` can be picked up and replaced without dragging. Anything
 * else keeps the default double-click.
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
