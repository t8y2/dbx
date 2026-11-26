import { foldService, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { elasticsearchRestRequestRanges } from "@/lib/sql/sqlStatementRanges";
import { isElasticsearchCompatibleDatabaseType, isMeilisearchDatabaseType, isSolrDatabaseType, type DatabaseType } from "@/types/database";

// `@lezer/common` is only a transitive dependency here (see sqlSyntaxTreeWindow.ts's comment on
// the same pattern), so derive the node types structurally instead of importing them.
type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolve"]>;
type Tree = ReturnType<typeof syntaxTree>;

export interface FoldRange {
  from: number;
  to: number;
}

// `@codemirror/lang-sql`'s grammar is deliberately shallow (see its `foldNodeProp`, which only
// covers the flat `Statement` and `BlockComment` nodes). This service adds structure-aware folds
// for procedural blocks and parenthesized query expressions without replacing CodeMirror's native
// folds.
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

// Comments are legal wherever whitespace is, so "END /* note */ CASE" is still a
// continuation. Scan once: a repeated regex can split a long `-----` comment in
// exponentially many ways when a label or other code follows it.
function gapIsWhitespaceOrComment(gap: string): boolean {
  let index = 0;
  while (index < gap.length) {
    if (/\s/.test(gap[index])) {
      index++;
    } else if (gap.startsWith("--", index)) {
      const newline = gap.indexOf("\n", index + 2);
      if (newline < 0) return true;
      index = newline + 1;
    } else if (gap.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (depth > 0 && index < gap.length) {
        if (gap.startsWith("/*", index)) {
          depth++;
          index += 2;
        } else if (gap.startsWith("*/", index)) {
          depth--;
          index += 2;
        } else {
          index++;
        }
      }
      if (depth > 0) return false;
    } else {
      return false;
    }
  }
  return true;
}

// A continuation word must also sit on the `END`'s own line: `END IF`/`END WHILE`/`END LOOP`/
// `END CASE`/`END TRY`/`END CATCH` are single-line closers, while T-SQL routinely writes the next
// statement's `IF` on the line right after a block's bare `END`. The whitespace-only gap check
// cannot tell the two apart -- a line break is whitespace -- so "END\n\nIF @b = 2" used to read as
// MySQL's `END IF`: that `END` never popped, the enclosing `BEGIN` stayed on the stack, and both
// its fold marker and its BEGIN/END match highlight disappeared as soon as a second
// `IF ... BEGIN ... END` followed the first (dbx#15561).
function isEndContinuation(state: EditorState, end: SyntaxNode, next: SyntaxNode | undefined): next is SyntaxNode {
  if (!next) return false;
  if (state.doc.lineAt(end.to).number !== state.doc.lineAt(next.from).number) return false;
  return gapIsWhitespaceOrComment(state.sliceDoc(end.to, next.from));
}

// `END IF` / `END WHILE` / `END LOOP` are statements in their own right, so MySQL and PL/SQL always
// terminate them with `;`. A one-line T-SQL script can instead put the *next* statement's opener in
// that same slot (`... END IF @b = 2 BEGIN ...`), which the same-line check alone still reads as a
// continuation of a construct this service never pushed. Treat end-of-document as a terminator so
// an unfinished `END IF` keeps the previous, harmless behaviour while the user is still typing.
// MySQL's `END WHILE lbl;` and Oracle's `END LOOP label;` carry one trailing label identifier
// (the `LEAVE lbl` idiom) before the terminator, so a single optional identifier is tolerated too.
function endsStatement(state: EditorState, node: SyntaxNode): boolean {
  const doc = state.doc;
  let pos = node.to;
  let labelAllowed = true;
  while (pos < doc.length) {
    const char = state.sliceDoc(pos, pos + 1);
    if (/\s/.test(char)) {
      pos++;
      continue;
    }
    if (char === "-" && state.sliceDoc(pos, pos + 2) === "--") {
      pos = doc.lineAt(pos).to + 1;
      continue;
    }
    if (char === "/" && state.sliceDoc(pos, pos + 2) === "/*") {
      const commentEnd = state.sliceDoc(pos, Math.min(doc.length, pos + 4096)).indexOf("*/");
      if (commentEnd < 0) return true;
      pos += commentEnd + 2;
      continue;
    }
    if (labelAllowed && /[A-Za-z_$]/.test(char)) {
      labelAllowed = false;
      pos++;
      while (pos < doc.length && /[A-Za-z0-9_$]/.test(state.sliceDoc(pos, pos + 1))) pos++;
      continue;
    }
    return char === ";";
  }
  return true;
}

// T-SQL transaction openers do not have a matching `END`, so they must not consume the closer
// of an enclosing procedural `BEGIN...END` block. Match complete keyword tokens only: `TRAN` is
// SQL Server's documented abbreviation, while similar identifiers such as `TRANS` remain blocks.
const SQLSERVER_TRANSACTION_BEGIN_WORDS = new Set(["TRAN", "TRANSACTION"]);

function isSqlServerTransactionBegin(state: EditorState, tokens: SyntaxNode[], index: number): boolean {
  const next = tokens[index + 1];
  if (!next || !gapIsWhitespaceOrComment(state.sliceDoc(tokens[index].to, next.from))) return false;

  const nextText = state.sliceDoc(next.from, next.to).toUpperCase();
  if (SQLSERVER_TRANSACTION_BEGIN_WORDS.has(nextText)) return true;
  if (nextText !== "DISTRIBUTED") return false;

  const transaction = tokens[index + 2];
  return Boolean(transaction && gapIsWhitespaceOrComment(state.sliceDoc(next.to, transaction.from)) && state.sliceDoc(transaction.from, transaction.to).toUpperCase() === "TRANSACTION");
}

// Keyed by the `Tree` instance (not `Text`): the syntax tree is also invalidated when the SQL
// dialect is reconfigured with the document unchanged (QueryEditor.vue's databaseType/dialect
// watcher), and when Lezer's incremental parser finishes covering more of a large document in the
// background -- both produce a new `Tree` without a new `Text`, so keying on `Text` alone would
// keep serving ranges computed from a stale or partial parse.
const rangeCache = new WeakMap<Tree, Map<string, Map<number, FoldRange>>>();
const blockPairsCache = new WeakMap<Tree, Array<{ opener: SyntaxNode; closer: SyntaxNode }>>();

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
      // Fold any multiline parenthesized expression, including large `IN (...)`
      // value lists. The opening line remains visible so the surrounding SQL
      // structure is still readable while the contents can be collapsed.
      if (node.name === "Parens") {
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

function addRestRequestFoldRanges(state: EditorState, ranges: Map<number, FoldRange>, databaseType?: DatabaseType): boolean {
  if (databaseType && !isElasticsearchCompatibleDatabaseType(databaseType) && !isMeilisearchDatabaseType(databaseType) && !isSolrDatabaseType(databaseType)) return false;
  const requests = elasticsearchRestRequestRanges(state.doc.toString(), databaseType ?? "elasticsearch");
  if (requests.length === 0) return false;

  for (const request of requests) {
    addMultilineFoldRange(state, ranges, request.from, request.to);
  }
  return true;
}

function sqlBlockPairs(state: EditorState, tree: Tree) {
  const cached = blockPairsCache.get(tree);
  if (cached) return cached;
  const tokens: SyntaxNode[] = [];
  tree.iterate({
    enter(node) {
      if (node.name === "Keyword") tokens.push(node.node);
    },
  });

  const pairs: Array<{ opener: SyntaxNode; closer: SyntaxNode }> = [];
  const stack: SyntaxNode[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const text = state.sliceDoc(token.from, token.to).toUpperCase();
    if (text === "END") {
      const next = tokens[i + 1];
      const continuation = isEndContinuation(state, token, next) ? state.sliceDoc(next.from, next.to).toUpperCase() : null;
      if (continuation && UNTRACKED_END_CONTINUATIONS.has(continuation)) {
        if (endsStatement(state, next!)) {
          i++; // "END IF"/"END WHILE"/... -- closes something we don't track; skip past it untouched
          continue;
        }
      } else if (continuation && TRACKED_END_CONTINUATIONS.has(continuation)) {
        i++; // "END CASE" -- consume the word, not a new opener
      }
      const opener = stack.pop();
      if (opener) pairs.push({ opener, closer: token });
    } else if (BLOCK_OPENERS.has(text) && (text !== "BEGIN" || !isSqlServerTransactionBegin(state, tokens, i))) {
      stack.push(token);
    }
  }
  blockPairsCache.set(tree, pairs);
  return pairs;
}

export function computeBlockFoldRanges(state: EditorState, databaseType?: DatabaseType, tree: Tree = syntaxTree(state)): Map<number, FoldRange> {
  const cacheByDatabaseType = rangeCache.get(tree);
  const cacheKey = databaseType ?? "auto-detect";
  const cached = cacheByDatabaseType?.get(cacheKey);
  if (cached) return cached;

  const byOpenerLine = new Map<number, FoldRange>();
  if (!addRestRequestFoldRanges(state, byOpenerLine, databaseType)) {
    for (const { opener, closer } of sqlBlockPairs(state, tree)) {
      addMultilineFoldRange(state, byOpenerLine, opener.from, closer.from, true);
    }
    addQueryStructureFoldRanges(state, tree, byOpenerLine);
  }
  const nextCacheByDatabaseType = cacheByDatabaseType ?? new Map<string, Map<number, FoldRange>>();
  nextCacheByDatabaseType.set(cacheKey, byOpenerLine);
  rangeCache.set(tree, nextCacheByDatabaseType);
  return byOpenerLine;
}

const matchingBlockKeyword = Decoration.mark({ class: "cm-matchingBracket" });

function beginEndDecorations(state: EditorState): DecorationSet {
  const selection = state.selection.main;
  if (!selection.empty) return Decoration.none;
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    const token = tree.resolveInner(selection.head, side);
    if (token.name !== "Keyword" || !/^(BEGIN|END)$/i.test(state.sliceDoc(token.from, token.to))) continue;
    const pair = sqlBlockPairs(state, tree).find(({ opener, closer }) => (opener.from === token.from || closer.from === token.from) && state.sliceDoc(opener.from, opener.to).toUpperCase() === "BEGIN");
    if (pair) return Decoration.set([matchingBlockKeyword.range(pair.opener.from, pair.opener.to), matchingBlockKeyword.range(pair.closer.from, pair.closer.to)]);
  }
  return Decoration.none;
}

export const sqlBeginEndMatching = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = beginEndDecorations(view.state);
    }

    update(update: ViewUpdate) {
      if (update.selectionSet || update.docChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = beginEndDecorations(update.state);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Creates folding for REST requests, procedural blocks, query parentheses, and UNION branches. */
export function createSqlBlockFoldService(databaseType?: DatabaseType | (() => DatabaseType | undefined), cachedRange?: (state: EditorState, lineStart: number) => FoldRange | null | undefined) {
  return foldService.of((state, lineStart) => {
    const cached = cachedRange?.(state, lineStart);
    if (cached !== undefined) return cached;
    const range = computeBlockFoldRanges(state, typeof databaseType === "function" ? databaseType() : databaseType).get(state.doc.lineAt(lineStart).number);
    return range ?? null;
  });
}

/** Public compatibility extension with REST request auto-detection for text editors. */
export const sqlBlockFoldService = createSqlBlockFoldService();
