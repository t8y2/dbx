import { DEFAULT_SQL_FORMATTER_SETTINGS, type SqlFormatterSettings } from "@/lib/sqlFormatterConfig";

export const MAX_MONGO_FORMAT_CHARS = 1_000_000;

interface FormatState {
  out: string;
  indentLevel: number;
  atLineStart: boolean;
  pendingSpace: boolean;
  chainIndent: boolean;
  pendingChainCall: boolean;
  stack: Array<{ char: string; expanded: boolean; chainCall?: boolean }>;
}

const CHAIN_METHODS = new Set(["find", "findOne", "aggregate", "countDocuments", "distinct", "insertOne", "insertMany", "updateOne", "updateMany", "deleteOne", "deleteMany", "getIndexes", "createIndex", "dropIndex", "dropIndexes", "sort", "limit", "skip"]);

export function formatMongoShellText(text: string, settings: Partial<SqlFormatterSettings> = DEFAULT_SQL_FORMATTER_SETTINGS): string {
  if (!text.trim()) return text;
  if (text.length > MAX_MONGO_FORMAT_CHARS) {
    throw new Error("MongoDB query is too large to format safely.");
  }

  const indentUnit = settings.useTabs ? "\t" : " ".repeat(settings.tabWidth ?? DEFAULT_SQL_FORMATTER_SETTINGS.tabWidth);
  const state: FormatState = { out: "", indentLevel: 0, atLineStart: true, pendingSpace: false, chainIndent: false, pendingChainCall: false, stack: [] };

  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (char === '"' || char === "'" || char === "`") {
      const literal = readQuotedLiteral(text, index, char);
      appendToken(state, literal.value, indentUnit);
      index = literal.end;
      continue;
    }

    if (char === "/" && next === "/") {
      const comment = readLineComment(text, index);
      appendToken(state, comment.value, indentUnit);
      index = comment.end;
      continue;
    }

    if (char === "/" && next === "*") {
      const comment = readBlockComment(text, index);
      appendToken(state, comment.value, indentUnit);
      index = comment.end;
      continue;
    }

    if (char === "/" && looksLikeRegexLiteral(text, index)) {
      const regex = readRegexLiteral(text, index);
      appendToken(state, regex.value, indentUnit);
      index = regex.end;
      continue;
    }

    if (/\s/.test(char)) {
      state.pendingSpace = !state.atLineStart;
      continue;
    }

    if (char === "." && shouldBreakBeforeDot(text, index)) {
      newline(state, indentUnit);
      state.chainIndent = true;
      state.pendingChainCall = true;
      appendToken(state, ".", indentUnit);
      continue;
    }

    if (char === "{" || char === "[" || char === "(") {
      appendToken(state, char, indentUnit);
      const expanded = char !== "(" && shouldExpandOpening(text, index);
      const isChainCall = char === "(" && state.pendingChainCall;
      state.stack.push({ char, expanded, chainCall: isChainCall });
      if (isChainCall) state.indentLevel++;
      state.pendingChainCall = false;
      if (expanded) {
        state.indentLevel++;
        newline(state, indentUnit);
      }
      continue;
    }

    if (char === "}" || char === "]" || char === ")") {
      const frame = popMatchingFrame(state, char);
      if (frame?.expanded) {
        if (!state.atLineStart) newline(state, indentUnit, -1);
        else state.indentLevel = Math.max(0, state.indentLevel - 1);
      }
      if (frame?.chainCall) {
        state.indentLevel = Math.max(0, state.indentLevel - 1);
      }
      appendRaw(state, char, indentUnit);
      continue;
    }

    if (char === ",") {
      appendToken(state, ",", indentUnit);
      newline(state, indentUnit);
      continue;
    }

    if (char === ":") {
      trimTrailingSpaces(state);
      appendRaw(state, ": ", indentUnit);
      state.pendingSpace = false;
      continue;
    }

    appendToken(state, char, indentUnit);
  }

  return cleanupFormattedMongoText(state.out);
}

function appendToken(state: FormatState, token: string, indentUnit: string) {
  if (state.atLineStart) {
    state.out += indentUnit.repeat(Math.max(0, state.indentLevel + (state.chainIndent ? 1 : 0)));
    state.atLineStart = false;
  } else if (state.pendingSpace && shouldInsertPendingSpace(state.out, token)) {
    state.out += " ";
  }
  state.out += token;
  state.pendingSpace = false;
  state.chainIndent = false;
}

function appendRaw(state: FormatState, token: string, indentUnit: string) {
  if (state.atLineStart) {
    state.out += indentUnit.repeat(Math.max(0, state.indentLevel + (state.chainIndent ? 1 : 0)));
    state.atLineStart = false;
  }
  state.out += token;
  state.pendingSpace = false;
  state.chainIndent = false;
}

function newline(state: FormatState, indentUnit: string, indentDelta = 0) {
  trimTrailingSpaces(state);
  if (!state.out.endsWith("\n")) state.out += "\n";
  state.indentLevel = Math.max(0, state.indentLevel + indentDelta);
  state.atLineStart = true;
  state.pendingSpace = false;
  state.chainIndent = false;
  void indentUnit;
}

function shouldInsertPendingSpace(output: string, token: string): boolean {
  const previous = lastNonWhitespace(output);
  if (!previous) return false;
  if ([".", "(", "[", "{"].includes(previous)) return false;
  if ([".", ")", "]", "}", ",", ":"].includes(token)) return false;
  return true;
}

function shouldExpandOpening(text: string, index: number): boolean {
  const close = matchingClose(text[index] ?? "");
  const nextNonSpace = findNextNonWhitespace(text, index + 1);
  if (nextNonSpace == null || text[nextNonSpace] === close) return false;
  return true;
}

function popMatchingFrame(state: FormatState, close: string): { char: string; expanded: boolean; chainCall?: boolean } | undefined {
  const expectedOpen = close === "}" ? "{" : close === "]" ? "[" : "(";
  for (let index = state.stack.length - 1; index >= 0; index--) {
    const frame = state.stack[index];
    state.stack.splice(index, state.stack.length - index);
    if (frame?.char === expectedOpen) return frame;
  }
  return undefined;
}

function shouldBreakBeforeDot(text: string, index: number): boolean {
  const method = readIdentifier(text, findNextNonWhitespace(text, index + 1) ?? index + 1);
  if (!method || !CHAIN_METHODS.has(method)) return false;
  const previousNonSpace = findPreviousNonWhitespace(text, index - 1);
  if (previousNonSpace == null) return false;
  return text[previousNonSpace] === ")";
}

function readQuotedLiteral(text: string, start: number, quote: string): { value: string; end: number } {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return { value: text.slice(start, index + 1), end: index };
    index++;
  }
  return { value: text.slice(start), end: text.length - 1 };
}

function readLineComment(text: string, start: number): { value: string; end: number } {
  const end = text.indexOf("\n", start);
  if (end < 0) return { value: text.slice(start), end: text.length - 1 };
  return { value: text.slice(start, end), end: end - 1 };
}

function readBlockComment(text: string, start: number): { value: string; end: number } {
  const end = text.indexOf("*/", start + 2);
  if (end < 0) return { value: text.slice(start), end: text.length - 1 };
  return { value: text.slice(start, end + 2), end: end + 1 };
}

function readRegexLiteral(text: string, start: number): { value: string; end: number } {
  let index = start + 1;
  let inCharClass = false;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[") inCharClass = true;
    else if (char === "]") inCharClass = false;
    else if (char === "/" && !inCharClass) {
      let end = index;
      while (/[a-z]/i.test(text[end + 1] ?? "")) end++;
      return { value: text.slice(start, end + 1), end };
    }
    index++;
  }
  return { value: text.slice(start), end: text.length - 1 };
}

function looksLikeRegexLiteral(text: string, index: number): boolean {
  const previous = findPreviousNonWhitespace(text, index - 1);
  if (previous == null) return true;
  return "({[,=:!&|?".includes(text[previous] ?? "");
}

function readIdentifier(text: string, start: number): string {
  let index = start;
  while (index < text.length && /[A-Za-z0-9_$]/.test(text[index] ?? "")) index++;
  return text.slice(start, index);
}

function matchingClose(open: string): string {
  if (open === "{") return "}";
  if (open === "[") return "]";
  return ")";
}

function findNextNonWhitespace(text: string, start: number): number | null {
  for (let index = start; index < text.length; index++) {
    if (!/\s/.test(text[index] ?? "")) return index;
  }
  return null;
}

function findPreviousNonWhitespace(text: string, start: number): number | null {
  for (let index = start; index >= 0; index--) {
    if (!/\s/.test(text[index] ?? "")) return index;
  }
  return null;
}

function lastNonWhitespace(text: string): string | null {
  const index = findPreviousNonWhitespace(text, text.length - 1);
  return index == null ? null : (text[index] ?? null);
}

function trimTrailingSpaces(state: FormatState) {
  state.out = state.out.replace(/[ \t]+$/g, "");
}

function cleanupFormattedMongoText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
