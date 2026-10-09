// Parser for pasting SQL INSERT statements into blank new rows (#10573).
// Accepts single or multiple statements and converts each VALUES tuple into a
// grid row. String literals keep their unescaped text (doubled quotes and
// MySQL backslash escapes), NULL becomes null, and every other token (numbers,
// functions, hex literals) is kept verbatim so the regular cell coercion
// handles it.

import { DATA_GRID_CLIPBOARD_BATCH_CHARS, DataGridClipboardCapacityError, finishDataGridRowPreparation, runDataGridRowPreparation, type DataGridClipboardLimits, type DataGridRowPreparationOptions, type DataGridRowPreparationProgress } from "./dataGridRowPreparation";

export interface ParsedInsertStatementPaste {
  rows: Array<Array<string | null>>;
  columnNames: string[] | null;
}

type CharClass = "code" | "single-quote" | "double-quote" | "backtick" | "bracket-ident";

interface ScanState {
  class: CharClass;
  text: string;
}

function appendRaw(state: ScanState, char: string): void {
  state.text += char;
}

function* splitTopLevelStatements(text: string): Generator<DataGridRowPreparationProgress, string[]> {
  const statements: string[] = [];
  const state: ScanState = { class: "code", text: "" };
  let depth = 0;
  let nextYield = DATA_GRID_CLIPBOARD_BATCH_CHARS;
  if (text.length > DATA_GRID_CLIPBOARD_BATCH_CHARS) yield { completed: 0, total: text.length * 2, phase: "parsing" };
  for (let index = 0; index < text.length; index++) {
    if (index >= nextYield) {
      yield { completed: index, total: text.length * 2, phase: "parsing" };
      nextYield = index + DATA_GRID_CLIPBOARD_BATCH_CHARS;
    }
    const char = text[index]!;
    if (state.class === "code") {
      if (char === "'" || char === '"' || char === "`") {
        state.class = char === "'" ? "single-quote" : char === '"' ? "double-quote" : "backtick";
        appendRaw(state, char);
        continue;
      }
      if (char === "[" && depth === 0) {
        state.class = "bracket-ident";
        appendRaw(state, char);
        continue;
      }
      if (char === "-" && text[index + 1] === "-") {
        while (index < text.length && text[index] !== "\n") index++;
        if (index < text.length) index--;
        continue;
      }
      if (char === "/" && text[index + 1] === "*") {
        index = text.indexOf("*/", index + 2);
        index = index === -1 ? text.length : index + 1;
        continue;
      }
      if (char === "(") depth++;
      if (char === ")") depth = Math.max(0, depth - 1);
      if (char === ";" && depth === 0) {
        if (state.text.trim()) statements.push(state.text);
        state.text = "";
        continue;
      }
      appendRaw(state, char);
      continue;
    }
    if (char === "\\" && (state.class === "single-quote" || state.class === "double-quote")) {
      // MySQL string escapes: \' must not end the literal (backticks keep
      // backslashes literal).
      appendRaw(state, char);
      if (index + 1 < text.length) appendRaw(state, text[++index]!);
      continue;
    }
    appendRaw(state, char);
    const closing = state.class === "single-quote" ? "'" : state.class === "double-quote" ? '"' : state.class === "backtick" ? "`" : "]";
    if (char === closing) {
      // Doubled quotes ('' / "" / ``) stay inside the literal; a doubled ]
      // inside a bracket identifier is not standard, so only quotes double.
      if (closing !== "]" && text[index + 1] === closing) {
        appendRaw(state, text[++index]!);
        continue;
      }
      state.class = "code";
    }
  }
  if (state.text.trim()) statements.push(state.text);
  return statements;
}

function normalizeIdentifier(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0]!;
    const last = trimmed[trimmed.length - 1]!;
    if ((first === "'" && last === "'") || (first === '"' && last === '"') || (first === "`" && last === "`")) {
      return trimmed.slice(1, -1).replaceAll(first + first, first);
    }
    if (first === "[" && last === "]") return trimmed.slice(1, -1).replaceAll("]]", "]");
  }
  return trimmed;
}

interface Lexer {
  source: string;
  pos: number;
  nextYield: number;
  progressOffset: number;
  progressTotal: number;
  maxItems: number;
}

function skipWhitespace(lexer: Lexer): void {
  while (lexer.pos < lexer.source.length && /\s/.test(lexer.source[lexer.pos]!)) lexer.pos++;
}

function matchKeyword(lexer: Lexer, keyword: string): boolean {
  skipWhitespace(lexer);
  const slice = lexer.source.slice(lexer.pos, lexer.pos + keyword.length);
  if (slice.toUpperCase() !== keyword) return false;
  const next = lexer.source[lexer.pos + keyword.length];
  if (next && !/[\s(]/.test(next)) return false;
  lexer.pos += keyword.length;
  return true;
}

function* readBracketedGroup(lexer: Lexer): Generator<DataGridRowPreparationProgress, string[] | null> {
  skipWhitespace(lexer);
  if (lexer.source[lexer.pos] !== "(") return null;
  lexer.pos++;
  const items: string[] = [];
  let current = "";
  let depth = 0;
  let classState: CharClass = "code";
  while (lexer.pos < lexer.source.length) {
    if (lexer.pos >= lexer.nextYield) {
      yield { completed: lexer.progressOffset + lexer.pos, total: lexer.progressTotal, phase: "parsing" };
      lexer.nextYield = lexer.pos + DATA_GRID_CLIPBOARD_BATCH_CHARS;
    }
    const char = lexer.source[lexer.pos++]!;
    if (classState === "code") {
      if (char === "'" || char === '"' || char === "`") {
        classState = char === "'" ? "single-quote" : char === '"' ? "double-quote" : "backtick";
      } else if (char === "[" && depth === 0) {
        classState = "bracket-ident";
      } else if (char === "(") {
        depth++;
      } else if (char === ")") {
        if (depth === 0) {
          if (items.length >= lexer.maxItems) throw new DataGridClipboardCapacityError();
          items.push(current);
          return items;
        }
        depth--;
      } else if (char === "," && depth === 0) {
        if (items.length >= lexer.maxItems) throw new DataGridClipboardCapacityError();
        items.push(current);
        current = "";
        continue;
      }
    } else if (char === "\\" && (classState === "single-quote" || classState === "double-quote")) {
      current += char;
      if (lexer.pos < lexer.source.length) current += lexer.source[lexer.pos++]!;
      continue;
    } else if (char === (classState === "bracket-ident" ? "]" : classState === "single-quote" ? "'" : classState === "double-quote" ? '"' : "`")) {
      classState = "code";
    }
    current += char;
  }
  return null;
}

function readValueToken(lexer: Lexer): string | null {
  skipWhitespace(lexer);
  if (lexer.pos >= lexer.source.length) return null;
  const start = lexer.pos;
  const char = lexer.source[lexer.pos]!;
  if (char === "'" || char === '"' || char === "`") {
    const closing = char;
    lexer.pos++;
    while (lexer.pos < lexer.source.length) {
      const inner = lexer.source[lexer.pos++]!;
      if (inner === closing) {
        if (lexer.source[lexer.pos] === closing) lexer.pos++;
        else break;
      } else if (inner === "\\" && closing !== "`") {
        if (lexer.pos < lexer.source.length) lexer.pos++;
      }
    }
    return lexer.source.slice(start, lexer.pos);
  }
  while (lexer.pos < lexer.source.length) {
    const inner = lexer.source[lexer.pos]!;
    // A table reference never contains commas, brackets, or whitespace, so the
    // first one of those ends the token (and leaves "(" for the column list).
    if (inner === "," || inner === "(" || inner === ")" || /\s/.test(inner)) break;
    lexer.pos++;
  }
  return lexer.source.slice(start, lexer.pos).trim() || null;
}

function unescapeSqlString(text: string): string {
  return text.replace(/\\(.)/gs, (_match, char: string) => {
    switch (char) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "0":
        return "\0";
      default:
        // \\ \' \" and unrecognized escapes keep the escaped character itself,
        // matching MySQL string-literal semantics.
        return char;
    }
  });
}

function convertValue(raw: string | null): string | null {
  if (raw === null) return null;
  let trimmed = raw.trim();
  if (trimmed.toUpperCase() === "NULL") return null;
  // Typed literals keep only the quoted payload: TIMESTAMP '...', DATE '...',
  // or a national-character prefix N'...'.
  const typed = trimmed.match(/^(?:N|DATE|TIME|TIMESTAMP|DATETIME)(?=\s*['"])/i);
  if (typed) trimmed = trimmed.slice(typed[0].length).trimStart();
  if (trimmed.length >= 2 && trimmed[0] === "'" && trimmed[trimmed.length - 1] === "'") {
    return unescapeSqlString(trimmed.slice(1, -1).replaceAll("''", "'"));
  }
  if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') {
    return unescapeSqlString(trimmed.slice(1, -1).replaceAll('""', '"'));
  }
  return trimmed;
}

function* parseSingleInsertStatement(statement: string, rows: ParsedInsertStatementPaste["rows"], limits: Required<DataGridClipboardLimits>, progressOffset: number, progressTotal: number, budget: { cells: number }): Generator<DataGridRowPreparationProgress, { columnNames: string[] | null } | null> {
  const lexer: Lexer = { source: statement, pos: 0, nextYield: DATA_GRID_CLIPBOARD_BATCH_CHARS, progressOffset, progressTotal, maxItems: limits.maxCells };
  if (!matchKeyword(lexer, "INSERT")) return null;
  if (!matchKeyword(lexer, "INTO")) return null;
  // Skip the table reference (possibly db.schema."table" or `db`.`table`).
  if (!readValueToken(lexer)) return null;
  // Optional column-name list: the next bracketed group before VALUES/VALUE.
  const save = lexer.pos;
  let columnNames: string[] | null = null;
  const group = yield* readBracketedGroup(lexer);
  if (group) {
    columnNames = group.map(normalizeIdentifier);
  } else {
    lexer.pos = save;
  }
  if (!matchKeyword(lexer, "VALUES") && !matchKeyword(lexer, "VALUE")) return null;
  const firstRow = rows.length;
  for (;;) {
    skipWhitespace(lexer);
    if (lexer.source[lexer.pos] !== "(") break;
    if (rows.length >= limits.maxRows) throw new DataGridClipboardCapacityError();
    lexer.maxItems = limits.maxCells - budget.cells;
    const rawValues = yield* readBracketedGroup(lexer);
    if (rawValues === null) return null;
    // Values inside a tuple: split on top-level commas again (readBracketedGroup
    // already did that) and convert each token.
    budget.cells += rawValues.length;
    rows.push(rawValues.map(convertValue));
    if (rows.length % 1000 === 0) yield { completed: progressOffset + lexer.pos, total: progressTotal, phase: "parsing" };
    skipWhitespace(lexer);
    if (lexer.source[lexer.pos] === ",") {
      lexer.pos++;
      continue;
    }
    break;
  }
  if (rows.length === firstRow) return null;
  return { columnNames };
}

export function parseInsertStatementPaste(text: string, limits: DataGridClipboardLimits = {}): ParsedInsertStatementPaste | null {
  return finishDataGridRowPreparation(prepareInsertStatementPaste(text, limits));
}

export function parseInsertStatementPasteInBatches(text: string, options: DataGridRowPreparationOptions = {}, limits: DataGridClipboardLimits = {}): Promise<ParsedInsertStatementPaste | null> {
  return runDataGridRowPreparation(prepareInsertStatementPaste(text, limits), options, null);
}

function* prepareInsertStatementPaste(text: string, limits: DataGridClipboardLimits): Generator<DataGridRowPreparationProgress, ParsedInsertStatementPaste | null> {
  const statements = yield* splitTopLevelStatements(text);
  // The first statement decides the paste's semantics; leading comments were
  // already stripped by the statement splitter.
  if (statements.length === 0 || !/^\s*insert\s+into\s/i.test(statements[0]!)) return null;
  const rows: Array<Array<string | null>> = [];
  let columnNames: string[] | null = null;
  let sawColumnNames = false;
  let progressOffset = text.length;
  const budget = { cells: 0 };
  const resolvedLimits = { maxRows: limits.maxRows ?? 100_000, maxCells: limits.maxCells ?? 1_000_000 };
  for (const statement of statements) {
    const parsed = yield* parseSingleInsertStatement(statement, rows, resolvedLimits, progressOffset, text.length * 2, budget);
    if (!parsed) return null;
    if (parsed.columnNames) {
      if (!sawColumnNames) {
        columnNames = parsed.columnNames;
        sawColumnNames = true;
      } else if (columnNames && parsed.columnNames.join("\u0000") !== columnNames.join("\u0000")) {
        columnNames = null;
      }
    }
    progressOffset += statement.length;
  }
  if (rows.length === 0) return null;
  return { rows, columnNames };
}
