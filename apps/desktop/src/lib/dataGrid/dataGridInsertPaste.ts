// Parser for pasting SQL INSERT statements into blank new rows (#10573).
// Accepts single or multiple statements and converts each VALUES tuple into a
// grid row. String literals keep their unescaped text, NULL becomes null, and
// every other token (numbers, functions, hex literals) is kept verbatim so the
// regular cell coercion handles it.

export interface ParsedInsertStatementPaste {
  rows: Array<Array<string | null>>;
  columnNames: string[] | null;
}

interface InsertStatementPart {
  columnNames: string[] | null;
  tuples: Array<Array<string | null>>;
}

type CharClass = "code" | "single-quote" | "double-quote" | "backtick" | "bracket-ident";

interface ScanState {
  class: CharClass;
  text: string;
}

function appendRaw(state: ScanState, char: string): void {
  state.text += char;
}

function splitTopLevelStatements(text: string): string[] {
  const statements: string[] = [];
  const state: ScanState = { class: "code", text: "" };
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
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

function readBracketedGroup(lexer: Lexer): string[] | null {
  skipWhitespace(lexer);
  if (lexer.source[lexer.pos] !== "(") return null;
  lexer.pos++;
  const items: string[] = [];
  let current = "";
  let depth = 0;
  let classState: CharClass = "code";
  while (lexer.pos < lexer.source.length) {
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
          items.push(current);
          return items;
        }
        depth--;
      } else if (char === "," && depth === 0) {
        items.push(current);
        current = "";
        continue;
      }
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

function convertValue(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.toUpperCase() === "NULL") return null;
  if (trimmed.length >= 2 && trimmed[0] === "'" && trimmed[trimmed.length - 1] === "'") {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function parseSingleInsertStatement(statement: string): InsertStatementPart | null {
  const lexer: Lexer = { source: statement, pos: 0 };
  if (!matchKeyword(lexer, "INSERT")) return null;
  if (!matchKeyword(lexer, "INTO")) return null;
  // Skip the table reference (possibly db.schema."table" or `db`.`table`).
  if (!readValueToken(lexer)) return null;
  // Optional column-name list: the next bracketed group before VALUES/VALUE.
  const save = lexer.pos;
  let columnNames: string[] | null = null;
  const group = readBracketedGroup(lexer);
  if (group) {
    columnNames = group.map(normalizeIdentifier);
  } else {
    lexer.pos = save;
  }
  if (!matchKeyword(lexer, "VALUES") && !matchKeyword(lexer, "VALUE")) return null;
  const tuples: Array<Array<string | null>> = [];
  for (;;) {
    skipWhitespace(lexer);
    if (lexer.source[lexer.pos] !== "(") break;
    const rawValues = readBracketedGroup(lexer);
    if (rawValues === null) return null;
    // Values inside a tuple: split on top-level commas again (readBracketedGroup
    // already did that) and convert each token.
    tuples.push(rawValues.map(convertValue));
    skipWhitespace(lexer);
    if (lexer.source[lexer.pos] === ",") {
      lexer.pos++;
      continue;
    }
    break;
  }
  if (tuples.length === 0) return null;
  return { columnNames, tuples };
}

export function parseInsertStatementPaste(text: string): ParsedInsertStatementPaste | null {
  const statements = splitTopLevelStatements(text);
  // The first statement decides the paste's semantics; leading comments were
  // already stripped by the statement splitter.
  if (statements.length === 0 || !/^\s*insert\s+into\s/i.test(statements[0]!)) return null;
  const rows: Array<Array<string | null>> = [];
  let columnNames: string[] | null = null;
  let sawColumnNames = false;
  for (const statement of statements) {
    const parsed = parseSingleInsertStatement(statement);
    if (!parsed) return null;
    if (parsed.columnNames) {
      if (!sawColumnNames) {
        columnNames = parsed.columnNames;
        sawColumnNames = true;
      } else if (columnNames && parsed.columnNames.join("\u0000") !== columnNames.join("\u0000")) {
        columnNames = null;
      }
    }
    rows.push(...parsed.tuples);
  }
  if (rows.length === 0) return null;
  return { rows, columnNames };
}
