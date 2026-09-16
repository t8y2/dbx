import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";
import { matchDollarQuoteTag } from "@/lib/sql/semantic/tokens";
import { expandToSqlStatementWindow, type TextRange } from "@/lib/sql/insertValueHints";

// `@lezer/common` (the package that declares `SyntaxNode`) is a transitive dependency, not a
// direct one, so pnpm's strict linking doesn't expose it for a direct type-only import here.
// Derive the type structurally from `syntaxTree`'s own return type instead of importing it.
type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolve"]>;

/**
 * Statement-window resolution backed by CodeMirror's own incrementally-parsed SQL syntax tree
 * (mounted on the live editor via `@codemirror/lang-sql`'s `sql()` extension -- see
 * QueryEditor.vue's `buildSqlLanguageExtension`), used as the provably-correct alternative to the
 * bounded heuristic scanner in insertValueHints.ts for callers that have a live `EditorState`.
 *
 * Never forces a parse (`ensureSyntaxTree` is intentionally not used): both functions here only
 * consult whatever CodeMirror has already parsed in the background (`syntaxTree`/
 * `syntaxTreeAvailable`). If the parse hasn't caught up to `cursor` yet (e.g. immediately after
 * opening a huge file), or the tree can't be trusted for the reason below, they return `null` and
 * the caller falls back to the existing scanner -- i.e. never worse than today's baseline.
 *
 * Known gap, disclosed rather than hidden: this app disables `doubleDollarQuotedStrings` in its
 * CodeMirror SQL dialect config (see codemirrorSqlDialect.ts, commit a067ee8d7 / issue #788) so
 * that PL/pgSQL `$$ ... $$` function bodies highlight as nested SQL instead of one opaque string.
 * That means the tree does NOT recognize a dollar-quoted body as a single unit -- it parses `;`
 * characters inside it as real statement boundaries. `resolveStatementWindowFromSyntaxTree` guards
 * against this with a bounded backward scan (see DOLLAR_QUOTE_DISTRUST_LOOKBACK) for unmatched
 * dollar-quote markers and returns `null` (safe fallback) rather than silently returning a wrong
 * window when it finds one. This guard is itself bounded, not a proof: a dollar-quote tag opened
 * further back than the lookback budget is invisible to it, same class of limitation as the old
 * scanner's known-imperfect case, just narrower in practice (needs the resolved statement's start
 * to also be more than the lookback distance from the real opening tag). That narrower residual
 * gap is called out explicitly to the maintainer rather than presented as fully solved -- see the
 * PR reply plan. Every *other* boundary class raised across three review rounds (unterminated
 * strings, comments, backslash escapes, CR-only comments, oversized statements) is fixed outright
 * by delegating to the grammar instead of re-deriving it.
 */

// Matches insertValueHints.ts's STATEMENT_LOOKBACK -- same budget, same tradeoff, used here only
// as a safety check rather than as the primary boundary-finding mechanism.
const DOLLAR_QUOTE_DISTRUST_LOOKBACK = 32 * 1024;

export function isEditorStatePlausibleFor(state: EditorState, sql: string): boolean {
  return state.doc.length === sql.length;
}

function hasUnresolvedDollarQuoteBefore(doc: Text, from: number, lookback: number): boolean {
  const scanStart = Math.max(0, from - lookback);
  const slice = doc.sliceString(scanStart, from);
  let openTag: string | null = null;
  for (let index = 0; index < slice.length; ) {
    if (slice[index] === "$") {
      const marker = matchDollarQuoteTag(slice, index);
      if (marker) {
        if (openTag === null) openTag = marker;
        else if (marker === openTag) openTag = null;
        index += marker.length;
        continue;
      }
    }
    index += 1;
  }
  // PostgreSQL closes a dollar-quoted body only with the exact opening delimiter. A different
  // tagged marker inside the body is ordinary text and must not accidentally balance the guard.
  return openTag !== null;
}

export function resolveSqlStatementWindow(sql: string, cursor: number, editorState: EditorState | undefined, dialectId: string): TextRange {
  const safeCursor = Math.max(0, Math.min(cursor, sql.length));
  if (editorState && isEditorStatePlausibleFor(editorState, sql)) {
    const window = resolveStatementWindowFromSyntaxTree(editorState, safeCursor);
    if (window) return window;
  }
  return expandToSqlStatementWindow(sql, safeCursor, safeCursor, dialectId);
}

/** Finds the nearest enclosing `Statement` node for `cursor`, resolving the trailing-whitespace
 * gap case (cursor after the last real token, before the next statement or end of document) via
 * `childBefore`, since `tree.resolve` on either side of such a gap lands on the root `Script`
 * node rather than a real node. */
function statementNodeAt(state: EditorState, cursor: number): SyntaxNode | null {
  const tree = syntaxTree(state);
  let node: SyntaxNode | null = tree.resolve(cursor, -1);
  if (node.name === "Script") {
    node = tree.topNode.childBefore(cursor + 1);
  }
  if (!node || node.type.isError) return null;

  let statementNode: SyntaxNode | null = node;
  while (statementNode && statementNode.name !== "Statement") {
    statementNode = statementNode.parent;
  }
  return statementNode;
}

/** Tree-based replacement for `expandToSqlStatementWindow`'s outer boundary, for callers with a
 * live `EditorState`. Returns `null` when the tree hasn't parsed up to `cursor` yet, when the
 * resolved node looks like an error-recovery node, or when a dollar-quoted body might be hiding
 * the true boundary (see module doc comment) -- the caller should fall back to the scanner. */
export function resolveStatementWindowFromSyntaxTree(state: EditorState, cursor: number): TextRange | null {
  if (!syntaxTreeAvailable(state, cursor)) return null;

  const statementNode = statementNodeAt(state, cursor);
  if (!statementNode) return null;

  const from = statementNode.from;
  const statementEnd = statementNode.to;
  if (cursor < from || (cursor > statementEnd && state.doc.sliceString(statementEnd, cursor).trim().length > 0)) return null;

  let to = statementEnd;
  const last = statementNode.lastChild;
  if (last && last.name === ";") to = last.from;

  // Error recovery can produce a partial Statement node that ends before the
  // completion cursor (for example `SELECT alias.`). Such a window is not an
  // enclosing statement and must fall back to the scanner.
  if (hasUnresolvedDollarQuoteBefore(state.doc, from, DOLLAR_QUOTE_DISTRUST_LOOKBACK)) return null;

  return { from, to };
}

/** Tree-based replacement for `getSqlLexicalContext`'s classification of the cursor position.
 * Classifies from the resolved leaf's node name alone: `String` (single- or dollar-quoted, per
 * the grammar's own tokenizer) is a literal; `LineComment`/`BlockComment` are comments;
 * `QuotedIdentifier` (double-quote/backtick/bracket) and everything else is neither, matching
 * getSqlLexicalContext's existing "only single/dollar-quoted text is a value literal" semantics. */
export function resolveLexicalLeafFromSyntaxTree(state: EditorState, cursor: number): { inLineComment: boolean; inBlockComment: boolean; inStringLiteral: boolean } | null {
  if (!syntaxTreeAvailable(state, cursor)) return null;

  const tree = syntaxTree(state);
  const node = tree.resolve(cursor, -1);
  if (node.type.isError) return null;

  return {
    inLineComment: node.name === "LineComment",
    inBlockComment: node.name === "BlockComment",
    inStringLiteral: node.name === "String",
  };
}
