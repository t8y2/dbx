import type { ChangeSet, EditorState, Transaction, TransactionSpec } from "@codemirror/state";
import { StreamLanguage, language, syntaxTree } from "@codemirror/language";
import { casedKeywordBefore, type SqlKeywordCaseMode } from "@/lib/sql/sqlKeywordCase";
import { loadedSqlFormatterEngine, loadEngine } from "@/lib/sql/layout/internals";
import { isSqlCommentContext, isSqlStringLiteralContext } from "@/lib/sql/sqlCompletion";
import { resolveLexicalLeafFromSyntaxTree, resolveStatementWindowFromSyntaxTree } from "@/lib/sql/sqlSyntaxTreeWindow";
import { expandToSqlStatementWindow } from "@/lib/sql/insertValueHints";
import { resolveSqlDialectId } from "@/lib/sql/semantic/dialect";
import type { SqlFormatDialect } from "@/lib/sql/sqlFormatter";
import type { DatabaseType } from "@/types/database";

/**
 * Re-casing the keyword just typed, the way DBeaver's
 * `SQL_FORMAT_KEYWORD_CASE_AUTO` does: when a space, punctuation character or
 * line break is entered, the word right before it is rewritten to
 * `sqlFormatter.keywordCase` — in the same update as the typed character, so one
 * keystroke stays one undo step.
 *
 * A transaction filter (rather than a Space keymap branch or an input handler)
 * because the three trigger kinds reach the document through different paths —
 * Space through the completion keymap or the browser input event, Enter through
 * `insertQueryEditorNewline` or CodeMirror's newline command — and the filter is
 * the one hook that sees all of them. `keepQueryEditorPasteCaretOnLastContentLine`
 * already establishes the `[transaction, { ...sequential: true }]` shape used
 * here for the follow-up edit.
 */

/** Statement windows past this size are left alone: tokenizing them per keypress is not free. */
const KEYWORD_CASE_WINDOW_MAX_CHARS = 16 * 1024;

/**
 * Documents past this size are also left alone when the syntax tree cannot
 * provide the statement window; the scanner fallback needs the whole text.
 */
const KEYWORD_CASE_FULL_DOC_MAX_CHARS = 200_000;

const IDENTIFIER_CHARACTER = /[\p{L}\p{N}_$#]/u;

/** The word the trigger character is terminating, at the end of the text before it. */
const TRAILING_WORD = /[\p{L}_][\p{L}\p{N}_$#]*$/u;

/** Characters that open a quoted identifier/literal or a qualifier segment. */
const NON_KEYWORD_PRECEDING_CHARACTERS = new Set(['"', "`", "'", "[", "."]);

function hasLezerSqlGrammar(state: EditorState): boolean {
  const mounted = state.facet(language);
  return !!mounted && !(mounted instanceof StreamLanguage);
}

export interface QueryEditorKeywordCaseOnTypeOptions {
  /** The user's `autoKeywordCase` preference; read per transaction so toggling it applies immediately. */
  enabled: () => boolean;
  /** The formatter's keyword case; `preserve` disables conversion. */
  keywordCase: () => SqlKeywordCaseMode | "preserve";
  dialect: () => SqlFormatDialect;
  databaseType: () => DatabaseType | undefined;
  /**
   * Called when a trigger cannot be classified yet (engine import still pending
   * and no usable syntax tree). The caller should enqueue it with
   * {@link createDeferredKeywordCaseQueue}.
   */
  onPending?: (pending: PendingKeywordCase) => void;
}

/** A trigger captured for later classification (see {@link deferredKeywordReplacement}). */
export interface PendingKeywordCase {
  word: string;
  wordFrom: number;
  wordEnd: number;
  /** The character(s) the trigger inserted right after the word (space, punctuation, line break + indent). */
  trigger: string;
  dialect: SqlFormatDialect;
  databaseType: DatabaseType | undefined;
  mode: SqlKeywordCaseMode;
}

/**
 * Whether `text` is a character whose entry should convert the word before it.
 *
 * Mirrors DBeaver: a line break, or exactly one character that cannot continue
 * an identifier. A dot is excluded on purpose — `t.select` is a qualified
 * identifier, and recasing the segment before the dot would rewrite a column
 * name (the one deliberate difference from DBeaver).
 */
function isKeywordCaseTrigger(text: string): boolean {
  if (text === "\n" || text === "\r" || text === "\r\n") return true;
  // Indented newline commands insert the line break plus the indent in one edit.
  if (/^\r?\n/.test(text)) return true;
  if (text.length !== 1) return false;
  if (IDENTIFIER_CHARACTER.test(text)) return false;
  return text !== ".";
}

/**
 * Start offset of the statement around `cursor`, or `null` when it cannot be
 * resolved cheaply or the cursor sits in a comment / string literal.
 *
 * The syntax tree is preferred — it is already parsed, needs no document string
 * and gives the lexical context in the same call. When the document is too large
 * for the grammar (StreamLanguage fallback) or has not been parsed up to the
 * cursor yet, the bounded scanner runs on the full text, which is only
 * affordable for ordinary-sized documents.
 */
function resolveKeywordCaseWindowStart(state: EditorState, cursor: number, options: { databaseType: () => DatabaseType | undefined }): number | null {
  // The node names the tree helpers read belong to the Lezer SQL grammar; with no
  // language mounted, or the StreamLanguage fallback used for oversized documents,
  // their answers describe a different tree (see sqlSyntaxTreeWindow.ts).
  const tree = hasLezerSqlGrammar(state) ? resolveStatementWindowFromSyntaxTree(state, cursor) : null;
  if (tree) {
    const leaf = resolveLexicalLeafFromSyntaxTree(state, cursor);
    if (!leaf) return null;
    if (leaf.inLineComment || leaf.inBlockComment || leaf.inStringLiteral) return null;
    return tree.from;
  }

  if (state.doc.length > KEYWORD_CASE_FULL_DOC_MAX_CHARS) return null;
  const sql = state.doc.toString();
  const databaseType = options.databaseType();
  const contextOptions = { databaseType, editorState: state };
  if (isSqlStringLiteralContext(sql, cursor, contextOptions) || isSqlCommentContext(sql, cursor, contextOptions)) return null;
  return expandToSqlStatementWindow(sql, cursor, cursor, resolveSqlDialectId({ databaseType })).from;
}

interface TypedInsert {
  text: string;
  /** Old-document offset the text was inserted at. */
  from: number;
}

/** A keyword rewrite in document offsets. */
export interface KeywordReplacement {
  from: number;
  to: number;
  insert: string;
}

/**
 * Provisional classifier for the window before the formatter engine's lazy
 * import has resolved — synchronously, from the editor's own Lezer SQL tree.
 *
 * The sql-formatter keyword lists remain the authority once the engine is
 * loaded (that is what keeps typing, the toolbar `a`/`A` and a later format
 * consistent). Without this fallback the very first keyword typed after a cold
 * start would silently stay uncased, because the import cannot be awaited
 * inside a synchronous transaction filter.
 */
export function casedKeywordFromSyntaxTree(state: EditorState, wordFrom: number, wordEnd: number, mode: SqlKeywordCaseMode): KeywordReplacement | null {
  if (!hasLezerSqlGrammar(state)) return null;
  const token = syntaxTree(state).resolveInner(wordEnd, -1);
  if (token.name !== "Keyword" || token.to !== wordEnd) return null;
  // `t.select` is a qualified segment, not a keyword position.
  if (token.parent?.name === "CompositeIdentifier") return null;
  const word = state.sliceDoc(wordFrom, wordEnd);
  // The resolved leaf must be exactly the word being finished (`select` in
  // `select(1)` is the same leaf; a neighbouring keyword must not be recased).
  if (!word || state.sliceDoc(token.from, token.to).toLowerCase() !== word.toLowerCase()) return null;
  const cased = mode === "upper" ? word.toUpperCase() : word.toLowerCase();
  if (cased === word) return null;
  return { from: wordFrom, to: wordEnd, insert: cased };
}

/** The typed text when the transaction is exactly one pure insertion, otherwise `null`. */
function singleTypedInsert(changes: ChangeSet): TypedInsert | null {
  let result: TypedInsert | null = null;
  let count = 0;
  changes.iterChanges((from, to, _insertedFrom, _insertedTo, inserted) => {
    count += 1;
    if (count > 1) return;
    // Only a pure insertion qualifies; a replacement is not typing a character.
    if (from !== to) return;
    result = { text: inserted.toString(), from };
  });
  return count === 1 ? result : null;
}

export function createQueryEditorKeywordCaseOnTypeFilter(options: QueryEditorKeywordCaseOnTypeOptions): (transaction: Transaction) => TransactionSpec | readonly TransactionSpec[] {
  // Warm the formatter engine up front when the feature is on: classification
  // then uses the same keyword lists as the formatter from the first keystroke.
  // (The syntax-tree fallback below only covers documents the Lezer grammar can
  // parse; large documents use the StreamLanguage tokenizer, whose tree the
  // fallback cannot read.)
  if (options.enabled()) void loadEngine();
  return (transaction: Transaction): TransactionSpec | readonly TransactionSpec[] => {
    if (!transaction.docChanged || transaction.startState.readOnly) return transaction;
    if (!transaction.isUserEvent("input")) return transaction;
    // Paste/drop/replace/IME-composition inserts must not rewrite surrounding text.
    if (transaction.isUserEvent("input.paste") || transaction.isUserEvent("input.drop") || transaction.isUserEvent("input.replace") || transaction.isUserEvent("input.type.compose")) return transaction;
    if (!options.enabled()) return transaction;
    const mode = options.keywordCase();
    if (mode !== "upper" && mode !== "lower") return transaction;

    const state = transaction.startState;
    // Multi-cursor and non-empty selections belong to block editing, not typing.
    if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return transaction;

    const insert = singleTypedInsert(transaction.changes);
    if (!insert || insert.from <= 0) return transaction;
    if (!isKeywordCaseTrigger(insert.text)) return transaction;

    const typed = insert.text;
    const wordEnd = insert.from;
    const lineFrom = state.doc.lineAt(wordEnd).from;
    const word = TRAILING_WORD.exec(state.sliceDoc(lineFrom, wordEnd))?.[0];
    if (!word) return transaction;
    const wordFrom = wordEnd - word.length;
    const preceding = wordFrom > 0 ? state.sliceDoc(wordFrom - 1, wordFrom) : "";
    // Quoted (`"select"`, `` `select` ``, `[select]`) or qualified (`t.select`) segments are identifiers.
    if (NON_KEYWORD_PRECEDING_CHARACTERS.has(preceding)) return transaction;

    const windowFrom = resolveKeywordCaseWindowStart(state, wordEnd, options);
    if (windowFrom === null) return transaction;
    const windowText = state.sliceDoc(windowFrom, wordEnd);
    if (windowText.length > KEYWORD_CASE_WINDOW_MAX_CHARS) return transaction;

    // The formatter's own keyword lists are authoritative. Until their lazy
    // import resolves, the syntax tree answers instead, so the first keyword
    // after a cold start still converts (see casedKeywordFromSyntaxTree).
    const engineReplacement = casedKeywordBefore(windowText, options.dialect(), mode);
    let replacement: KeywordReplacement | null = engineReplacement && { from: windowFrom + engineReplacement.from, to: windowFrom + engineReplacement.to, insert: engineReplacement.insert };
    if (!replacement && loadedSqlFormatterEngine() === null) {
      replacement = casedKeywordFromSyntaxTree(state, wordFrom, wordEnd, mode);
      // Neither classifier can answer yet: remember the word and let the caller
      // apply the authoritative conversion once the import resolves.
      if (!replacement) options.onPending?.({ word, wordFrom, wordEnd, trigger: typed, dialect: options.dialect(), databaseType: options.databaseType(), mode });
    }
    if (!replacement) return transaction;

    return [
      transaction,
      {
        changes: replacement,
        // A transaction without its own selection (programmatic inserts) would
        // otherwise keep the pre-typing caret, which never advances past the
        // character just inserted; real typing carries its own selection and is
        // mapped through the change below.
        ...(transaction.selection ? {} : { selection: { anchor: insert.from + typed.length } }),
        userEvent: "input.type",
        sequential: true,
      },
    ];
  };
}

/**
 * The authoritative conversion for a trigger captured via
 * {@link QueryEditorKeywordCaseOnTypeOptions.onPending}, against the document as
 * it is *now*.
 *
 * Returns `null` — leave the text alone — when the document moved on:
 * the word was edited or became part of a longer identifier, the position
 * no longer exists, or the word is (still) not a keyword. The word-boundary
 * check matters: `select` captured at [0,6) must not turn `selectx` into
 * `SELECTx` if the user kept typing.
 */
export function deferredKeywordReplacement(state: EditorState, pending: PendingKeywordCase): KeywordReplacement | null {
  if (state.readOnly || pending.wordEnd > state.doc.length) return null;
  if (state.sliceDoc(pending.wordFrom, pending.wordEnd) !== pending.word) return null;
  // The trigger the user typed must still be there: an undo or backspace that
  // removed it means the queued conversion was abandoned mid-type. It also
  // re-proves the word boundary, since every trigger is a non-identifier
  // character (`selectx` can never match a captured `select` + space).
  if (state.sliceDoc(pending.wordEnd, pending.wordEnd + pending.trigger.length) !== pending.trigger) return null;

  const windowFrom = resolveKeywordCaseWindowStart(state, pending.wordEnd, { databaseType: () => pending.databaseType });
  if (windowFrom === null) return null;
  const windowText = state.sliceDoc(windowFrom, pending.wordEnd);
  if (windowText.length > KEYWORD_CASE_WINDOW_MAX_CHARS) return null;

  const replacement = casedKeywordBefore(windowText, pending.dialect, pending.mode);
  return replacement && { from: windowFrom + replacement.from, to: windowFrom + replacement.to, insert: replacement.insert };
}

export interface DeferredKeywordCaseQueueOptions {
  /** Re-checked when the import resolves: the user may have disabled the feature meanwhile. */
  isEnabled: () => boolean;
  /** The live document, or `null` when that editor is gone. */
  getState: () => EditorState | null;
  dispatch: (replacement: KeywordReplacement) => void;
}

export interface DeferredKeywordCaseQueue {
  enqueue(pending: PendingKeywordCase): void;
  /** Invalidate every queued conversion (the typed boundary no longer exists). */
  cancelAll(): void;
}

/**
 * Queues triggers captured while the formatter engine was loading, then applies
 * the authoritative conversion once `loadEngine()` resolves.
 *
 * History's undo/redo transactions are dispatched with `filter: false`, so a
 * transaction filter never sees them; the caller must wire `cancelAll()` from
 * an `EditorView.updateListener`. `deferredKeywordReplacement` re-validates the
 * word and the typed trigger anyway, so a stale entry cannot corrupt the text
 * even if the cancel is missed.
 */
export function createDeferredKeywordCaseQueue(options: DeferredKeywordCaseQueueOptions): DeferredKeywordCaseQueue {
  let generation = 0;
  return {
    enqueue(pending) {
      const expected = generation;
      void loadEngine().then((engine) => {
        if (!engine || expected !== generation || !options.isEnabled()) return;
        const state = options.getState();
        if (!state) return;
        const replacement = deferredKeywordReplacement(state, pending);
        if (replacement) options.dispatch(replacement);
      });
    },
    cancelAll() {
      generation += 1;
    },
  };
}
