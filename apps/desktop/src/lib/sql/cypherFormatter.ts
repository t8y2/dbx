import type { SqlFormatterSettings } from "@/lib/sql/sqlFormatterConfig";

type CypherTokenKind = "word" | "number" | "string" | "quotedIdentifier" | "comment" | "operator" | "punctuation" | "parameter";

interface CypherToken {
  kind: CypherTokenKind;
  text: string;
  lineBreakBefore: boolean;
  blankLineBefore: boolean;
}

interface CypherTokenizeResult {
  tokens: CypherToken[];
  trailingLineBreak: boolean;
}

interface CypherClause {
  words: string[];
  end: number;
  name: string;
}

const CLAUSE_WORDS = new Set(["CALL", "CREATE", "DELETE", "DETACH", "DROP", "ENABLE", "FOREACH", "GRANT", "LIMIT", "LOAD", "MATCH", "MERGE", "OPTIONAL", "REMOVE", "RENAME", "RETURN", "REVOKE", "SET", "SHOW", "SKIP", "START", "TERMINATE", "UNION", "UNWIND", "USE", "WHERE", "WITH", "YIELD"]);

const MULTIWORD_CLAUSES: string[][] = [
  ["DETACH", "DELETE"],
  ["LOAD", "CSV"],
  ["ON", "CREATE", "SET"],
  ["ON", "MATCH", "SET"],
  ["OPTIONAL", "MATCH"],
  ["ORDER", "BY"],
  ["START", "WITH"],
  ["UNION", "ALL"],
];

const FORMAT_KEYWORDS = new Set([
  "ALL",
  "AND",
  "AS",
  "ASC",
  "BY",
  "CALL",
  "CASE",
  "CREATE",
  "DELETE",
  "DESC",
  "DETACH",
  "DISTINCT",
  "ELSE",
  "END",
  "FOREACH",
  "IN",
  "IS",
  "LIMIT",
  "LOAD",
  "MATCH",
  "MERGE",
  "NOT",
  "NULL",
  "ON",
  "OPTIONAL",
  "OR",
  "ORDER",
  "REMOVE",
  "RETURN",
  "SET",
  "SKIP",
  "START",
  "THEN",
  "TRUE",
  "UNION",
  "UNWIND",
  "WHEN",
  "WHERE",
  "WITH",
  "XOR",
  "YIELD",
  "FALSE",
]);

const LOGICAL_WORDS = new Set(["AND", "OR", "XOR"]);
const PROJECTION_CLAUSES = new Set(["RETURN", "WITH", "YIELD"]);
const CLAUSE_BOUNDARY_WORDS = CLAUSE_WORDS;
const MULTI_CHAR_OPERATORS = ["<--", "-->", "->", "<-", "..", "=~", "<=", ">=", "<>", "!=", "+=", "-=", "*=", "/=", "||", "::"];
const SINGLE_CHAR_OPERATORS = new Set(["+", "-", "/", "%", "=", "<", ">", "!", "?", "|", "&", "^", "~", "*"]);
const PUNCTUATION = new Set(["(", ")", "[", "]", "{", "}", ",", ";", ".", ":"]);

function isWordStart(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}_]/u.test(char);
}

function isWordPart(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}_]/u.test(char);
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/u.test(char);
}

function codePointAt(source: string, index: number): string | undefined {
  const point = source.codePointAt(index);
  return point === undefined ? undefined : String.fromCodePoint(point);
}

function advanceCodePoint(source: string, index: number): number {
  const point = source.codePointAt(index);
  return point === undefined ? index + 1 : index + (point > 0xffff ? 2 : 1);
}

function scanQuoted(source: string, start: number, quote: "'" | '"' | "`"): number | null {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\" && quote !== "`" && index + 1 < source.length) {
      index += 2;
      continue;
    }
    if (source[index] === quote) {
      // Cypher escapes backticks and SQL-style quote literals by doubling them.
      if (source[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index = advanceCodePoint(source, index);
  }
  return null;
}

function scanBlockComment(source: string, start: number): number | null {
  let depth = 1;
  let index = start + 2;
  while (index < source.length) {
    if (source.startsWith("/*", index)) {
      depth += 1;
      index += 2;
    } else if (source.startsWith("*/", index)) {
      depth -= 1;
      index += 2;
      if (depth === 0) return index;
    } else {
      index = advanceCodePoint(source, index);
    }
  }
  return null;
}

function scanParameter(source: string, start: number): number | null {
  if (source[start + 1] === "{") {
    const end = source.indexOf("}", start + 2);
    return end < 0 ? null : end + 1;
  }

  let index = start + 1;
  while (isWordPart(codePointAt(source, index))) index = advanceCodePoint(source, index);
  return index;
}

function scanNumber(source: string, start: number): number {
  let index = start;
  while (/[\p{N}_]/u.test(source[index] ?? "")) index += 1;
  if (source[index] === "." && source[index + 1] !== ".") {
    index += 1;
    while (/[\p{N}_]/u.test(source[index] ?? "")) index += 1;
  }
  if (source[index] === "e" || source[index] === "E") {
    let exponent = index + 1;
    if (source[exponent] === "+" || source[exponent] === "-") exponent += 1;
    const digits = exponent;
    while (/[\p{N}_]/u.test(source[exponent] ?? "")) exponent += 1;
    if (exponent > digits) index = exponent;
  }
  return index;
}

function tokenizeCypher(source: string): CypherTokenizeResult | null {
  const tokens: CypherToken[] = [];
  let index = 0;
  let lineBreakBefore = false;
  let blankLineBefore = false;

  const push = (kind: CypherTokenKind, text: string) => {
    tokens.push({ kind, text, lineBreakBefore, blankLineBefore });
    lineBreakBefore = false;
    blankLineBefore = false;
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (isWhitespace(char)) {
      let newlines = 0;
      while (index < source.length && isWhitespace(source[index])) {
        if (source[index] === "\n") newlines += 1;
        if (source[index] === "\r" && source[index + 1] !== "\n") newlines += 1;
        index += 1;
      }
      if (newlines > 0) {
        lineBreakBefore = true;
        blankLineBefore ||= newlines > 1;
      }
      continue;
    }

    if ((char === "/" && next === "/") || (char === "-" && next === "-")) {
      const start = index;
      index += 2;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
      push("comment", source.slice(start, index));
      continue;
    }

    if (char === "/" && next === "*") {
      const end = scanBlockComment(source, index);
      if (end === null) return null;
      push("comment", source.slice(index, end));
      index = end;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      const end = scanQuoted(source, index, char);
      if (end === null) return null;
      push(char === "`" ? "quotedIdentifier" : "string", source.slice(index, end));
      index = end;
      continue;
    }

    if (char === "$") {
      const end = scanParameter(source, index);
      if (end === null || end === index + 1) return null;
      push("parameter", source.slice(index, end));
      index = end;
      continue;
    }

    const point = codePointAt(source, index);
    if (isWordStart(point)) {
      const start = index;
      index = advanceCodePoint(source, index);
      while (isWordPart(codePointAt(source, index))) index = advanceCodePoint(source, index);
      push("word", source.slice(start, index));
      continue;
    }

    if (/[\p{N}]/u.test(point ?? "")) {
      const end = scanNumber(source, index);
      push("number", source.slice(index, end));
      index = end;
      continue;
    }

    const operator = MULTI_CHAR_OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (operator) {
      push("operator", operator);
      index += operator.length;
      continue;
    }

    if (SINGLE_CHAR_OPERATORS.has(char)) {
      push("operator", char);
      index += 1;
      continue;
    }

    if (PUNCTUATION.has(char)) {
      push("punctuation", char);
      index += 1;
      continue;
    }

    // A formatter must never guess how an unknown character participates in a
    // Cypher token. Returning null keeps full-width punctuation and future DSL
    // extensions untouched instead of silently changing their meaning.
    return null;
  }

  return { tokens, trailingLineBreak: lineBreakBefore };
}

function upper(token: CypherToken): string {
  return token.kind === "word" ? token.text.toUpperCase() : token.text;
}

function clauseAt(tokens: readonly CypherToken[], index: number, depth: { paren: number; bracket: number; brace: number }): CypherClause | null {
  if (depth.paren !== 0 || depth.bracket !== 0 || depth.brace !== 0) return null;
  const token = tokens[index];
  if (!token || token.kind !== "word") return null;

  for (const words of MULTIWORD_CLAUSES) {
    if (words.every((word, offset) => tokens[index + offset]?.kind === "word" && upper(tokens[index + offset]) === word)) {
      return { words, end: index + words.length, name: words.join(" ") };
    }
  }

  const word = upper(token);
  if (!CLAUSE_BOUNDARY_WORDS.has(word)) return null;
  return { words: [word], end: index + 1, name: word };
}

function caseText(text: string, setting: SqlFormatterSettings["keywordCase"]): string {
  if (setting === "upper") return text.toUpperCase();
  if (setting === "lower") return text.toLowerCase();
  return text;
}

function isAtom(token: CypherToken | undefined): boolean {
  return token !== undefined && (token.kind === "word" || token.kind === "number" || token.kind === "string" || token.kind === "quotedIdentifier" || token.kind === "parameter");
}

function isPathOperator(token: CypherToken | undefined, next: CypherToken | undefined, previous: CypherToken | undefined): boolean {
  if (!token || token.kind !== "operator") return false;
  if (token.text === "->" || token.text === "<-" || token.text === "-->" || token.text === "<--") return true;
  return token.text === "-" && (next?.text === "(" || next?.text === "[" || previous?.text === ")" || previous?.text === "]" || previous?.text === "}");
}

function needsSpace(previous: CypherToken | undefined, current: CypherToken, next: CypherToken | undefined, mapColon: boolean): boolean {
  if (!previous) return false;
  const previousText = previous.text;
  const currentText = current.text;

  if ([")", "]", "}", ",", ";", ".", ":"].includes(currentText)) return false;
  if (["(", "[", "."].includes(previousText)) return false;
  if (previousText === ":") return mapColon;
  if (previousText === ",") return true;
  if (currentText === "(") return ["AND", "CASE", "ELSE", "MATCH", "NOT", "OPTIONAL", "OR", "THEN", "WHEN", "WHERE", "XOR"].includes(previousText.toUpperCase());
  if (currentText === "[") {
    if (isPathOperator(previous, current, undefined)) return false;
    if (previous.kind === "word" && ["ALL", "ANY", "IN", "NONE", "SINGLE"].includes(previousText.toUpperCase())) return true;
    return !isAtom(previous) && previousText !== ")" && previousText !== "]" && previousText !== "}";
  }
  if (currentText === "{") return previousText === "," || (previousText !== "(" && previousText !== "[" && previous.kind !== "operator");
  if (currentText === "-") return !isPathOperator(current, next, previous);
  if (current.kind === "operator") {
    if (currentText === ".." || currentText === ":") return false;
    if (isPathOperator(current, next, previous)) return false;
    if (currentText === "!") return false;
    return true;
  }
  if (previous.kind === "operator") {
    if (previousText === ".." || previousText === ":" || previousText === "!") return false;
    if (previousText === "-" && current.kind === "number") return false;
    if (isPathOperator(previous, current, undefined)) return false;
    return true;
  }
  if (previousText === "(") return false;
  return isAtom(previous) || previousText === ")" || previousText === "]" || previousText === "}";
}

class CypherPrinter {
  private readonly lines: string[] = [];
  private current = "";
  private lineIndent = 0;
  private previous: CypherToken | undefined;
  private depth = { paren: 0, bracket: 0, brace: 0 };
  private clauseName = "";
  private clauseDepth = { paren: 0, bracket: 0, brace: 0 };
  private continuationIndent = 1;
  private mapColon = false;
  private recognizedClauses = 0;

  constructor(private readonly settings: SqlFormatterSettings) {}

  get hasRecognizedClause(): boolean {
    return this.recognizedClauses > 0;
  }

  format(tokens: readonly CypherToken[], trailingLineBreak: boolean): string {
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      const clause = clauseAt(tokens, index, this.depth);
      if (clause) {
        this.startClause(clause, tokens, index);
        this.previous = tokens[clause.end - 1];
        index = clause.end - 1;
        continue;
      }

      if (token.kind === "comment") {
        this.writeComment(token);
        this.previous = token;
        continue;
      }

      if (token.blankLineBefore && this.settings.preserveEmptyLines && this.current.trim()) this.newline(this.lineIndent, true);

      const relativeTopLevel = this.isAtClauseTopLevel();
      const word = token.kind === "word" ? upper(token) : "";
      if (relativeTopLevel && LOGICAL_WORDS.has(word) && this.settings.logicalOperatorNewline !== "none") {
        if (this.settings.logicalOperatorNewline === "before") this.newline(this.continuationIndent);
        this.writeWord(token, word);
        if (this.settings.logicalOperatorNewline === "after") this.newline(this.continuationIndent);
        this.previous = token;
        continue;
      }

      if (token.text === "," && relativeTopLevel && PROJECTION_CLAUSES.has(this.clauseName)) {
        this.writeToken(token, index + 1 < tokens.length ? tokens[index + 1] : undefined);
        this.newline(this.continuationIndent);
        this.previous = token;
        continue;
      }

      if (token.text === ";") {
        this.writeToken(token, tokens[index + 1]);
        this.newline(0);
        this.clauseName = "";
        this.previous = token;
        continue;
      }

      if (token.kind === "word" && FORMAT_KEYWORDS.has(word) && !this.isSemanticIdentifier(tokens[index + 1])) {
        this.writeWord(token, word);
      } else {
        this.writeToken(token, tokens[index + 1]);
      }

      this.updateDepth(token);
      this.previous = token;
    }

    this.flush();
    let output = this.lines.join("\n");
    if (trailingLineBreak && output) output += "\n";
    return output;
  }

  private startClause(clause: CypherClause, tokens: readonly CypherToken[], start: number): void {
    if (this.current.trim()) this.newline(0);
    this.clauseName = clause.name;
    this.clauseDepth = { ...this.depth };
    this.continuationIndent = this.lineIndent + 1;
    this.recognizedClauses += 1;
    clause.words.forEach((word, offset) => {
      this.writeWord(tokens[start + offset], word, offset > 0);
    });
  }

  private writeWord(token: CypherToken, word: string, forceSpace = false): void {
    const text = this.settings.keywordCase === "preserve" ? token.text : caseText(word, this.settings.keywordCase);
    this.writeToken({ ...token, text }, undefined, forceSpace);
  }

  private writeToken(token: CypherToken, next: CypherToken | undefined, forceSpace = false): void {
    const atLineStart = this.current.trim().length === 0;
    if (!atLineStart && (forceSpace || needsSpace(this.previous, token, next, this.mapColon))) this.current += " ";
    this.current += token.text;
    this.mapColon = token.text === ":" && this.depth.brace > 0;
  }

  private writeComment(token: CypherToken): void {
    if (token.lineBreakBefore && this.current.trim()) this.newline(this.lineIndent);
    if (this.current.trim() && !this.current.endsWith(" ")) this.current += " ";
    this.current += token.text;
    if (token.text.startsWith("//") || token.text.startsWith("--") || token.text.includes("\n")) this.newline(this.lineIndent);
  }

  private updateDepth(token: CypherToken): void {
    if (token.text === "(") this.depth.paren += 1;
    else if (token.text === ")") this.depth.paren -= 1;
    else if (token.text === "[") this.depth.bracket += 1;
    else if (token.text === "]") this.depth.bracket -= 1;
    else if (token.text === "{") this.depth.brace += 1;
    else if (token.text === "}") this.depth.brace -= 1;
  }

  private isAtClauseTopLevel(): boolean {
    return this.depth.paren === this.clauseDepth.paren && this.depth.bracket === this.clauseDepth.bracket && this.depth.brace === this.clauseDepth.brace;
  }

  private isSemanticIdentifier(next: CypherToken | undefined): boolean {
    return this.previous?.text === "." || this.previous?.text === ":" || (this.depth.brace > 0 && next?.text === ":") || next?.text === "(";
  }

  private newline(indent: number, forceBlank = false): void {
    this.flush();
    if (forceBlank && this.lines.length > 0 && this.lines[this.lines.length - 1] !== "") this.lines.push("");
    this.lineIndent = indent;
    this.current = this.indent(indent);
    this.previous = undefined;
  }

  private indent(level: number): string {
    return this.settings.useTabs ? "\t".repeat(level) : " ".repeat(level * this.settings.tabWidth);
  }

  private flush(): void {
    const line = this.current.trimEnd();
    if (line.trim()) this.lines.push(line);
    this.current = this.indent(this.lineIndent);
  }
}

/**
 * Formats the supported Cypher query subset used by the Neo4j editor.
 *
 * This is intentionally a lexical formatter, not a Cypher parser. It only
 * changes whitespace around recognized clauses and top-level projections. All
 * literals, comments, parameters, labels, relationship patterns, maps, lists,
 * and nested expressions remain opaque token text. Inputs outside that safe
 * boundary are returned unchanged.
 */
export function formatCypherText(sql: string, settings: SqlFormatterSettings): string {
  const tokenized = tokenizeCypher(sql);
  if (!tokenized || tokenized.tokens.length === 0) return sql;

  const stack: string[] = [];
  for (const token of tokenized.tokens) {
    if (token.text === "(" || token.text === "[" || token.text === "{") stack.push(token.text);
    if (token.text === ")" || token.text === "]" || token.text === "}") {
      const expected = token.text === ")" ? "(" : token.text === "]" ? "[" : "{";
      if (stack.pop() !== expected) return sql;
    }
  }
  if (stack.length > 0) return sql;

  const printer = new CypherPrinter(settings);
  const formatted = printer.format(tokenized.tokens, tokenized.trailingLineBreak);
  return printer.hasRecognizedClause && formatted.trim() ? formatted : sql;
}

/** Compresses Cypher without treating `//` as ordinary SQL text. */
export function compressCypherText(sql: string): string {
  const tokenized = tokenizeCypher(sql);
  if (!tokenized || tokenized.tokens.length === 0) return sql;

  const stack: string[] = [];
  let output = "";
  let previous: CypherToken | undefined;
  let mapColon = false;

  for (let index = 0; index < tokenized.tokens.length; index += 1) {
    const token = tokenized.tokens[index];
    if (token.text === "(" || token.text === "[" || token.text === "{") stack.push(token.text);
    if (token.text === ")" || token.text === "]" || token.text === "}") {
      const expected = token.text === ")" ? "(" : token.text === "]" ? "[" : "{";
      if (stack.pop() !== expected) return sql;
    }
    if (token.kind === "comment") continue;

    const next = tokenized.tokens[index + 1];
    if (output && needsSpace(previous, token, next, mapColon)) output += " ";
    output += token.text;
    mapColon = token.text === ":" && stack.includes("{");
    previous = token;
  }

  if (stack.length > 0 || !output.trim()) return sql;
  return output.trim();
}
