import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import type { SqlSemanticToken } from "@/lib/sql/semantic/types";

/**
 * Routine bodies are the one shape the clause layout printer cannot structure.
 *
 * sql-formatter's grammar has no block nodes, so `CREATE PROCEDURE ... AS BEGIN
 * ... END` parses as a flat clause list — `CREATE PROCEDURE`, `SELECT`, `FROM`,
 * and then a separate statement holding the leftover `END` keywords. The printer
 * therefore emits one clause per line at column 0, and the body keeps no
 * indentation at all, which is what users see when they format a stored
 * procedure.
 *
 * This pass restores the block structure from the token stream *after*
 * formatting: it keeps the printer's clause layout inside each statement and
 * adds the line breaks and indentation the block keywords imply. It only
 * inserts whitespace — every token is emitted verbatim, so the statement the
 * user ends up with is the one they started with, plus the missing structure.
 */

const ROUTINE_KEYWORDS = new Set(["procedure", "proc", "function", "trigger", "package"]);

/**
 * `BEGIN` also starts a transaction, which is a statement rather than a block.
 * Those forms must not open an indented body, or every following statement
 * would be nested under it.
 */
const NON_BLOCK_BEGIN = new Set(["transaction", "tran", "distributed", "work"]);

/** `END` closes a block together with the word that names it: `END IF`, `END LOOP`, ... */
const END_SUFFIXES = new Set(["if", "loop", "while", "case", "try", "catch", "repeat"]);

/**
 * Statements inside a routine body that the clause layout cannot start a line
 * for on its own — it only breaks at clause boundaries, so a `PRINT` or an `IF`
 * that follows a `FROM` would otherwise stay on that line.
 */
const STATEMENT_STARTERS = new Set(["if", "while", "else", "return", "print", "exec", "execute", "throw", "raiserror", "waitfor", "goto", "break", "continue"]);

function previousSignificantToken(tokens: SqlSemanticToken[], index: number): SqlSemanticToken | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (tokens[cursor].kind !== "comment") return tokens[cursor];
  }
  return undefined;
}

function nextSignificantToken(tokens: SqlSemanticToken[], index: number): SqlSemanticToken | undefined {
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor].kind !== "comment") return tokens[cursor];
  }
  return undefined;
}

function wordAt(tokens: SqlSemanticToken[], index: number): string {
  const tokenValue = tokens[index];
  return tokenValue?.kind === "word" ? tokenValue.normalized : "";
}

/** `CREATE [OR ALTER|OR REPLACE] PROCEDURE|PROC|FUNCTION|TRIGGER|PACKAGE ...` */
function routineDefinitionPosition(tokens: SqlSemanticToken[]): number {
  let cursor = 0;
  while (cursor < tokens.length && tokens[cursor].kind === "comment") cursor += 1;
  if (wordAt(tokens, cursor) !== "create") return -1;
  cursor += 1;

  const next = wordAt(tokens, cursor);
  if (next === "or") {
    const modifier = wordAt(tokens, cursor + 1);
    if (modifier !== "alter" && modifier !== "replace") return -1;
    cursor += 2;
  }
  return ROUTINE_KEYWORDS.has(wordAt(tokens, cursor)) ? cursor : -1;
}

/** A routine body only needs re-indenting when it actually contains a block. */
function hasBlockBody(tokens: SqlSemanticToken[]): boolean {
  return tokens.some((tokenValue, index) => {
    if (tokenValue.kind !== "word" || tokenValue.normalized !== "begin" || tokenValue.depth !== 0) return false;
    return !NON_BLOCK_BEGIN.has(nextSignificantToken(tokens, index)?.normalized ?? "");
  });
}

function lineIndentation(sql: string, offset: number): string {
  const lineStart = Math.max(sql.lastIndexOf("\n", offset - 1), sql.lastIndexOf("\r", offset - 1)) + 1;
  return /^[ \t]*/.exec(sql.slice(lineStart, offset))![0];
}

function indentationWidth(indent: string, tabWidth: number): number {
  let width = 0;
  for (const character of indent) width += character === "\t" ? tabWidth - (width % tabWidth) : 1;
  return width;
}

/**
 * Retain the interior of Oracle routine block comments while the SQL
 * printer lays out the surrounding code. Restore them after routine indenting
 * so each continuation line can follow the comment's final indentation.
 */
export function protectOracleRoutineComments(sql: string, tabWidth: number): { sql: string; restore: (formatted: string) => string } | undefined {
  if (!sql.includes("/*") || !/[\r\n]/.test(sql)) return undefined;

  const tokens = tokenizeSqlSemantic(sql, "oracle");
  const routinePosition = routineDefinitionPosition(tokens);
  if (routinePosition === -1 || (wordAt(tokens, routinePosition) !== "package" && !hasBlockBody(tokens))) return undefined;

  let namespace = 0;
  while (sql.includes(`__DBX_ORACLE_ROUTINE_COMMENT_${namespace}_`)) namespace += 1;
  const markerPrefix = `__DBX_ORACLE_ROUTINE_COMMENT_${namespace}_`;
  const comments: { text: string; indentWidth: number }[] = [];
  let from = 0;
  let masked = "";
  for (const token of tokens) {
    if (token.kind !== "comment" || !token.text.startsWith("/*") || token.text.startsWith("/*+") || !token.text.endsWith("*/") || !/[\r\n]/.test(token.text)) continue;
    masked += sql.slice(from, token.span.start) + `/*${markerPrefix}${comments.length}__*/`;
    from = token.span.end;
    comments.push({ text: token.text, indentWidth: indentationWidth(lineIndentation(sql, token.span.start), tabWidth) });
  }
  if (comments.length === 0) return undefined;

  const markers = new RegExp(`/\\*${markerPrefix}(\\d+)__\\*/`, "g");
  return {
    sql: masked + sql.slice(from),
    restore: (formatted) =>
      formatted.replace(markers, (marker, index: string, offset: number) => {
        const comment = comments[Number(index)];
        if (!comment) return marker;
        const indent = lineIndentation(formatted, offset);
        return comment.text.replace(/(\r\n|\r|\n)([ \t]*)(?=[^ \t\r\n])/g, (_line, newline: string, whitespace: string) => {
          const relativeWidth = Math.max(0, indentationWidth(whitespace, tabWidth) - comment.indentWidth);
          return newline + indent + " ".repeat(relativeWidth);
        });
      }),
  };
}

/**
 * Re-indents the block structure of a routine definition, leaving every other
 * input untouched.
 *
 * Oracle package specifications also have an `IS`/`END` declaration block
 * without a `BEGIN`.
 */
export function indentRoutineBlocks(sql: string, dialectId: string, indentWidth: number, useTabs: boolean): string {
  if (!sql.trim()) return sql;

  const tokens = tokenizeSqlSemantic(sql, dialectId);
  const routinePosition = routineDefinitionPosition(tokens);
  if (routinePosition === -1) return sql;
  const oracle = dialectId === "oracle";
  const oraclePackage = oracle && wordAt(tokens, routinePosition) === "package";
  const packageBody = oraclePackage && nextSignificantToken(tokens, routinePosition)?.normalized === "body";
  const packageSpecification = oraclePackage && !packageBody;
  if (!packageSpecification && !hasBlockBody(tokens)) return sql;

  const indentUnit = useTabs ? "\t" : " ".repeat(Math.max(1, indentWidth));
  const lines: string[] = [];
  let current = "";
  let level = 0;
  // `CASE ... END` closes with the same keyword as a block, so its depth is
  // tracked separately and its `END` is never treated as a block terminator.
  let caseDepth = 0;
  // `IF ... THEN` (PL/SQL) opens a body without a `BEGIN`, so its depth is
  // counted apart from `BEGIN` blocks to let `ELSE` close and reopen it.
  let thenBlocks = 0;
  let headerDone = false;
  let forceBreak = false;
  let previousWord = "";
  let previousToken: SqlSemanticToken | undefined;
  const declarationLevels: number[] = [];
  let cursorHeader = false;
  let cursorQuery = false;

  const flush = () => {
    const trimmed = current.replace(/\s+$/, "");
    if (trimmed) lines.push(trimmed);
    current = "";
  };
  const startLine = () => {
    if (current.trim()) flush();
  };
  const write = (text: string) => {
    current = current.trim() ? current + text : indentUnit.repeat(level) + text;
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const tokenValue = tokens[index];
    const gap = previousToken ? sql.slice(previousToken.span.end, tokenValue.span.start) : "";

    const word = tokenValue.kind === "word" ? tokenValue.normalized : "";
    const nextWord = nextSignificantToken(tokens, index)?.normalized ?? "";
    const previous = previousSignificantToken(tokens, index);
    const isBlockBegin = word === "begin" && tokenValue.depth === 0 && !NON_BLOCK_BEGIN.has(nextWord);
    // Package members have their own signatures and declaration sections.
    // They must not inherit the package header's completed state.
    const startsMember = packageBody && (word === "procedure" || word === "function") && (previous?.text === ";" || previousWord === "is" || previousWord === "as");
    if (startsMember) {
      startLine();
      headerDone = false;
    }
    if (oracle && word === "cursor" && tokenValue.depth === 0 && declarationLevels[declarationLevels.length - 1] === level - 1) cursorHeader = true;
    if (isBlockBegin && declarationLevels[declarationLevels.length - 1] === level - 1) level = declarationLevels.pop()!;
    // A `CASE` expression owns its `THEN`/`ELSE`/`END`; none of them is block syntax.
    const closesCase = word === "end" && tokenValue.depth === 0 && caseDepth > 0;
    const isBlockEnd = word === "end" && tokenValue.depth === 0 && caseDepth === 0;
    // `IF(...)` as a function call and `a = IF(...)` keep their line: only a
    // statement position starts a new one.
    const atStatementPosition = previous === undefined || (previous.kind === "word" && previous.normalized !== "select") || (previous.kind === "punctuation" && previous.text !== ",");
    // A `CASE` expression owns its `THEN`/`ELSE`/`END`; none of them is block syntax.
    const isStatementStart = !packageSpecification && STATEMENT_STARTERS.has(word) && headerDone && level > 0 && tokenValue.depth === 0 && caseDepth === 0 && previousWord !== "end" && atStatementPosition;
    const startsElsif = oracle && word === "elsif";
    const closesThenBlock = (word === "else" || startsElsif) && thenBlocks > 0 && tokenValue.depth === 0 && caseDepth === 0;
    const breaksBeforeElse = word === "else" && caseDepth === 0;
    // The header's `AS`/`IS` separates the signature from the body and always
    // sits on a line of its own.
    const isHeaderSeparator = !headerDone && (word === "as" || word === "is") && tokenValue.depth === 0;
    // A signature stays on one line even when the printer split it: the clause
    // rules have no clause to hang a routine header on, so some dialects emit it
    // one token per line.
    const joinsHeader = (!headerDone && !isHeaderSeparator && !isBlockBegin) || (oraclePackage && isHeaderSeparator) || cursorHeader;
    // `BEGIN TRY` / `END CATCH` name their block with a second keyword, which
    // the clause layout treats as its own token and breaks away.
    const joinsBlockSuffix = (previousWord === "begin" && (word === "try" || word === "catch")) || (previousWord === "end" && (END_SUFFIXES.has(word) || (oracle && previous?.normalized === "end" && (tokenValue.kind === "word" || tokenValue.kind === "quoted_identifier"))));
    if (joinsBlockSuffix) forceBreak = false;

    if ((forceBreak && !joinsBlockSuffix) || (gap.includes("\n") && !joinsHeader && !joinsBlockSuffix)) {
      startLine();
      forceBreak = false;
    }
    if (isStatementStart || isBlockBegin || isBlockEnd || closesThenBlock || (isHeaderSeparator && !oraclePackage) || breaksBeforeElse) startLine();
    if (isBlockEnd || closesThenBlock) level = Math.max(0, level - 1);

    // The gap is empty exactly where the input had no whitespace (`a.b`, `(x)`),
    // so reusing it keeps the printer's spacing inside a line. A statement
    // terminator never takes a space, even where the printer emitted one.
    const isTerminator = tokenValue.kind === "punctuation" && tokenValue.text === ";";
    const spacing = isTerminator ? "" : gap.includes("\n") ? " " : gap;
    write((current.trim() ? spacing : "") + tokenValue.text);

    if (closesCase) {
      caseDepth -= 1;
    } else if (isBlockBegin) {
      headerDone = true;
      level += 1;
      // `BEGIN TRY` / `BEGIN CATCH` name their block, so the suffix stays on the
      // keyword's line and the break happens after it instead.
      forceBreak = !END_SUFFIXES.has(nextWord);
    } else if (word === "try" || word === "catch") {
      forceBreak = true;
    } else if (isBlockEnd) {
      forceBreak = !END_SUFFIXES.has(nextWord) && nextSignificantToken(tokens, index)?.text !== ";";
    } else if (END_SUFFIXES.has(word) && previousWord === "end") {
      if (word === "if") thenBlocks = Math.max(0, thenBlocks - 1);
      forceBreak = nextSignificantToken(tokens, index)?.text !== ";";
    } else if (word === "case") {
      caseDepth += 1;
    } else if (word === "then" && tokenValue.depth === 0 && caseDepth === 0) {
      thenBlocks += 1;
      level += 1;
      forceBreak = true;
    } else if (word === "loop" && tokenValue.depth === 0 && previousWord !== "end") {
      level += 1;
      forceBreak = true;
    } else if (closesThenBlock) {
      if (startsElsif) {
        // The ELSIF condition opens its replacement body only when THEN arrives.
        thenBlocks -= 1;
      } else {
        level += 1;
        forceBreak = true;
      }
    } else if (breaksBeforeElse) {
      forceBreak = true;
    } else if (tokenValue.kind === "punctuation" && tokenValue.text === ";" && tokenValue.depth === 0) {
      forceBreak = true;
      if (cursorQuery) {
        level = Math.max(0, level - 1);
        cursorQuery = false;
      }
    } else if (tokenValue.kind === "comment" && (tokenValue.text.startsWith("--") || tokenValue.text.startsWith("#"))) {
      forceBreak = true;
    } else if (isHeaderSeparator) {
      headerDone = true;
      forceBreak = true;
      if (oracle) {
        declarationLevels.push(level);
        level += 1;
      }
    }

    if (cursorHeader && word === "is") {
      cursorHeader = false;
      cursorQuery = true;
      level += 1;
      forceBreak = true;
    }

    if (word) previousWord = word;
    previousToken = tokenValue;
  }

  flush();
  return lines.join("\n");
}
