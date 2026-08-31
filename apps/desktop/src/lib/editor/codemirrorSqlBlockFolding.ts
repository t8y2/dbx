import { foldService, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

// `@lezer/common` is only a transitive dependency here (see sqlSyntaxTreeWindow.ts's comment on
// the same pattern), so derive the node types structurally instead of importing them.
type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolve"]>;
type Tree = ReturnType<typeof syntaxTree>;

interface FoldRange {
  from: number;
  to: number;
}

// `@codemirror/lang-sql`'s grammar is deliberately shallow (see its `foldNodeProp`, which only
// covers the flat `Statement` and `BlockComment` nodes). This service adds structure-aware folds
// for procedural blocks and query expressions without replacing CodeMirror's native folds.
//
// Scoped to `BEGIN...END` and `CASE...END` (issue #6574) -- `BEGIN TRY`/`END TRY` and
// `BEGIN CATCH`/`END CATCH` fall out of this for free, since `BEGIN` is matched regardless of a
// trailing word. `IF`/`WHILE`/`LOOP` are deliberately excluded as openers: MySQL's
// `IF(cond, a, b)` is a builtin scalar function, so treating bare `IF` as a block opener would
// misparse every such call as an unterminated block and desync all fold ranges after it. T-SQL
// (the dialect in #6574) doesn't need `IF` support anyway -- its `IF`/`ELSE` bodies are
// themselves wrapped in `BEGIN...END`, which this already folds.
const BLOCK_OPENERS = new Set(["BEGIN", "CASE"]);
// Continuation words whose `END <word>` pairing closes something this service DID push an opener
// for, so the `END` must pop the stack: `END CASE` closes a procedural `CASE` (the CASE-expression
// form closes with plain `END` instead); `END TRY`/`END CATCH` close T-SQL's `BEGIN TRY`/
// `BEGIN CATCH` -- the leading `BEGIN` there already pushed a generic entry (see BLOCK_OPENERS;
// the following `TRY`/`CATCH` word itself isn't inspected on push), so its closer must be
// recognized too or that entry is never popped and desyncs every fold range after it.
const TRACKED_END_CONTINUATIONS = new Set(["CASE", "TRY", "CATCH"]);
// `END IF`/`END WHILE`/`END LOOP` close constructs with no `BEGIN`/`CASE` prefix at all -- bare
// `IF`/`WHILE`/`LOOP` are never pushed (see BLOCK_OPENERS comment), so these `END`s must NOT pop
// the stack; nothing on it belongs to them.
const UNTRACKED_END_CONTINUATIONS = new Set(["IF", "WHILE", "LOOP"]);

// A comment is legal SQL wherever whitespace is, so "END /* note */ CASE" must still read as a
// continuation; this matches a run of pure whitespace and/or `--`/`/* */` comments so real code
// between the two words (e.g. a `;` starting an unrelated statement) still fails the check.
const GAP_IS_WHITESPACE_OR_COMMENT = /^(?:\s|--[^\n]*|\/\*[\s\S]*?\*\/)*$/;

// T-SQL transaction openers do not have a matching `END`, so they must not consume the closer
// of an enclosing procedural `BEGIN...END` block. Match complete keyword tokens only: `TRAN` is
// SQL Server's documented abbreviation, while similar identifiers such as `TRANS` remain blocks.
const SQLSERVER_TRANSACTION_BEGIN_WORDS = new Set(["TRAN", "TRANSACTION"]);

function isSqlServerTransactionBegin(state: EditorState, tokens: SyntaxNode[], index: number): boolean {
  const next = tokens[index + 1];
  if (!next || !GAP_IS_WHITESPACE_OR_COMMENT.test(state.sliceDoc(tokens[index].to, next.from))) return false;

  const nextText = state.sliceDoc(next.from, next.to).toUpperCase();
  if (SQLSERVER_TRANSACTION_BEGIN_WORDS.has(nextText)) return true;
  if (nextText !== "DISTRIBUTED") return false;

  const transaction = tokens[index + 2];
  return Boolean(transaction && GAP_IS_WHITESPACE_OR_COMMENT.test(state.sliceDoc(next.to, transaction.from)) && state.sliceDoc(transaction.from, transaction.to).toUpperCase() === "TRANSACTION");
}

// Keyed by the `Tree` instance (not `Text`): the syntax tree is also invalidated when the SQL
// dialect is reconfigured with the document unchanged (QueryEditor.vue's databaseType/dialect
// watcher), and when Lezer's incremental parser finishes covering more of a large document in the
// background -- both produce a new `Tree` without a new `Text`, so keying on `Text` alone would
// keep serving ranges computed from a stale or partial parse.
const rangeCache = new WeakMap<Tree, Map<number, FoldRange>>();

function addMultilineFoldRange(state: EditorState, ranges: Map<number, FoldRange>, openerPosition: number, endPosition: number, overwrite = false) {
  const openerLine = state.doc.lineAt(openerPosition);
  const endLine = state.doc.lineAt(endPosition);
  if (openerLine.number === endLine.number || endPosition <= openerLine.to || (!overwrite && ranges.has(openerLine.number))) return;
  ranges.set(openerLine.number, { from: openerLine.to, to: endPosition });
}

function queryParent(node: SyntaxNode): SyntaxNode | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === "Parens" || parent.name === "Statement") return parent;
  }
  return null;
}

function queryScopeKey(node: SyntaxNode): string {
  return `${node.name}:${node.from}:${node.to}`;
}

function queryScopeEnd(state: EditorState, scope: SyntaxNode): number {
  const lastChild = scope.lastChild;
  if (scope.name === "Parens" && lastChild?.name === ")") return lastChild.from;

  let end = scope.to;
  while (end > scope.from && /\s/.test(state.sliceDoc(end - 1, end))) end--;
  if (end > scope.from && state.sliceDoc(end - 1, end) === ";") end--;
  return end;
}

function isQueryParens(state: EditorState, node: SyntaxNode): boolean {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "(" || child.name === "LineComment" || child.name === "BlockComment") continue;
    if (child.name !== "Keyword") return false;
    const keyword = state.sliceDoc(child.from, child.to).toUpperCase();
    return keyword === "SELECT" || keyword === "WITH";
  }
  return false;
}

interface QueryScopeTokens {
  scope: SyntaxNode;
  tokens: Array<{ from: number; keyword: "SELECT" | "UNION" }>;
  hasUnion: boolean;
}

export function collectUnionBranchFoldRanges(tokens: ReadonlyArray<{ from: number; keyword: "SELECT" | "UNION" }>, scopeEnd: number): FoldRange[] {
  const ranges: FoldRange[] = [];
  let branchEnd = scopeEnd;

  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index];
    if (token.keyword === "UNION") {
      branchEnd = token.from;
    } else {
      ranges.push({ from: token.from, to: branchEnd });
    }
  }

  ranges.reverse();
  return ranges;
}

function addQueryStructureFoldRanges(state: EditorState, tree: Tree, ranges: Map<number, FoldRange>) {
  const scopes = new Map<string, QueryScopeTokens>();
  tree.iterate({
    enter(node) {
      if (node.name === "Parens" && isQueryParens(state, node.node)) {
        addMultilineFoldRange(state, ranges, node.from, queryScopeEnd(state, node.node));
      }
      if (node.name !== "Keyword") return;
      const keyword = state.sliceDoc(node.from, node.to).toUpperCase();
      if (keyword !== "SELECT" && keyword !== "UNION") return;
      const scope = queryParent(node.node);
      if (!scope) return;
      const key = queryScopeKey(scope);
      const group = scopes.get(key) ?? { scope, tokens: [], hasUnion: false };
      group.tokens.push({ from: node.from, keyword });
      if (keyword === "UNION") group.hasUnion = true;
      scopes.set(key, group);
    },
  });

  for (const { scope, tokens, hasUnion } of scopes.values()) {
    if (!hasUnion) continue;
    const branchRanges = collectUnionBranchFoldRanges(tokens, queryScopeEnd(state, scope));
    for (const range of branchRanges) {
      addMultilineFoldRange(state, ranges, range.from, range.to);
    }
  }
}

function computeBlockFoldRanges(state: EditorState): Map<number, FoldRange> {
  const tree = syntaxTree(state);
  const cached = rangeCache.get(tree);
  if (cached) return cached;

  const byOpenerLine = new Map<number, FoldRange>();
  const tokens: SyntaxNode[] = [];
  tree.iterate({
    enter(node) {
      if (node.name === "Keyword") tokens.push(node.node);
    },
  });

  const stack: SyntaxNode[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const text = state.sliceDoc(token.from, token.to).toUpperCase();
    if (text === "END") {
      const next = tokens[i + 1];
      const continuation = next && GAP_IS_WHITESPACE_OR_COMMENT.test(state.sliceDoc(token.to, next.from)) ? state.sliceDoc(next.from, next.to).toUpperCase() : null;
      if (continuation && UNTRACKED_END_CONTINUATIONS.has(continuation)) {
        i++; // "END IF"/"END WHILE"/... -- closes something we don't track; skip past it untouched
        continue;
      }
      if (continuation && TRACKED_END_CONTINUATIONS.has(continuation)) i++; // "END CASE" -- consume the word, not a new opener
      const opener = stack.pop();
      if (opener) {
        const openerLine = state.doc.lineAt(opener.to);
        const endLine = state.doc.lineAt(token.from);
        // Same source line as its opener (e.g. "BEGIN END"): nothing to collapse, and the
        // from/to formula below would otherwise invert (from > to) since `from` is the end of
        // that shared line while `to` is a position earlier on it.
        if (openerLine.number !== endLine.number) {
          addMultilineFoldRange(state, byOpenerLine, opener.from, token.from, true);
        }
      }
    } else if (BLOCK_OPENERS.has(text) && (text !== "BEGIN" || !isSqlServerTransactionBegin(state, tokens, i))) {
      stack.push(token);
    }
  }

  addQueryStructureFoldRanges(state, tree, byOpenerLine);

  rangeCache.set(tree, byOpenerLine);
  return byOpenerLine;
}

/** Adds procedural-block, query-parenthesis, and UNION-branch folds to the SQL editor. */
export const sqlBlockFoldService = foldService.of((state, lineStart) => {
  const range = computeBlockFoldRanges(state).get(state.doc.lineAt(lineStart).number);
  return range ?? null;
});
