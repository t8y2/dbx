/**
 * MongoDB shell command diagnostics for the query editor.
 *
 * Mirrors `redisSyntaxDiagnostics.ts` so the editor's diagnostic pipeline
 * (StateField + Decoration.mark) renders them with no extra wiring. The source is
 * split into commands with the same splitter the executor uses, so an underline
 * always corresponds to a statement that would fail or warrant care when run.
 */
import type { SqlTextSpan } from "@/types/database";
import type { SqlSemanticDiagnostic } from "@/lib/sql/semantic/diagnostics";
import { findMatchingParen, hasUnclosedMongoDelimiters, trimMongoOuterComments } from "@dbx-app/mongo-shell";
import { bulkWriteFilters, describeMongoCommandParseFailure, mongoFilterIsEffectivelyUnbounded, parseMongoCommand, splitMongoCommandTextRanges, type MongoCommand, type MongoTextRange } from "@/lib/mongo/mongoShellCommand";

const UNCLOSED_MESSAGE = "MongoDB command has unclosed parentheses, brackets, braces, or strings.";

/**
 * `db.<collection>.<method>` / `db["…"].<method>` / `db.getCollection("…").<method>` /
 * `db.getSiblingDB("…").<collection>.<method>` / `db.<method>` — the part worth underlining by default.
 * Call forms come first so `.getCollection("x")` is consumed whole instead of stopping at the name.
 */
const COMMAND_HEAD = /^\s*db\s*(?:\.\s*(?:getCollection|getSiblingDB)\s*\([^)]*\)|\.\s*[A-Za-z_$][\w$]*|\[[^\]]*\])*(?:\s*\.\s*[A-Za-z_$][\w$]*)?/;

export function buildMongoSyntaxDiagnostics(source: string, cursor = -1): SqlSemanticDiagnostic[] {
  const diagnostics: SqlSemanticDiagnostic[] = [];
  const segments = splitMongoCommandTextRanges(source);
  const current = segmentAtCursor(segments, cursor, source.length);

  for (const segment of segments) {
    const text = trimMongoOuterComments(segment.text).trim().replace(/;$/, "").trim();
    if (!text) continue;

    if (hasUnclosedMongoDelimiters(text)) {
      // A command still being typed under the cursor is not an error yet.
      if (segment === current) continue;
      diagnostics.push({ span: spanFor(source, segment.from, segment.to), message: UNCLOSED_MESSAGE, severity: "error" });
      continue;
    }

    const parsed = parseMongoCommand(segment.text);
    if (!parsed) {
      const message = describeMongoCommandParseFailure(segment.text);
      diagnostics.push({ span: errorSpan(source, segment, message), severity: "error", message });
      continue;
    }

    const warning = describeMongoWriteRisk(parsed.command);
    if (warning) diagnostics.push({ span: headSpan(source, segment), severity: "warning", message: warning });
  }

  return diagnostics;
}

/**
 * Hold off while the cursor sits inside a command whose delimiters are still
 * open — the user is mid-expression and everything after that point is noise.
 * Mirrors the intent of `shouldRunRedisDiagnostics`.
 */
export function shouldRunMongoDiagnostics(source: string, cursor: number): boolean {
  if (!source.trim()) return false;
  const current = segmentAtCursor(splitMongoCommandTextRanges(source), cursor, source.length);
  if (!current) return true;
  const text = trimMongoOuterComments(current.text).trim();
  return !text || !hasUnclosedMongoDelimiters(text);
}

/** The command the cursor is in, counting the whitespace after it up to the next command. */
function segmentAtCursor(segments: readonly MongoTextRange[], cursor: number, sourceLength: number): MongoTextRange | undefined {
  if (cursor < 0) return undefined;
  return segments.find((segment, index) => cursor >= segment.from && cursor <= (segments[index + 1]?.from ?? sourceLength));
}

/* ------------------------------------------------------------------ *
 * Warnings for commands that parse but deserve a second look
 * ------------------------------------------------------------------ */

function describeMongoWriteRisk(command: MongoCommand): string | null {
  switch (command.kind) {
    case "update":
    case "delete": {
      if (!mongoFilterIsEffectivelyUnbounded(command.filter)) return null;
      const verb = command.kind === "update" ? "update" : "delete";
      return command.many ? `This ${verb} has no effective filter and will ${verb} every document in ${command.collection}.` : `This ${verb} has no effective filter and will ${verb} an arbitrary document in ${command.collection}.`;
    }
    case "replace":
      return mongoFilterIsEffectivelyUnbounded(command.filter) ? `This replace has no effective filter and will replace an arbitrary document in ${command.collection}.` : null;
    case "findOneAndUpdate":
    case "findOneAndReplace":
    case "findOneAndDelete": {
      if (!mongoFilterIsEffectivelyUnbounded(command.filter)) return null;
      const verb = command.kind === "findOneAndUpdate" ? "update" : command.kind === "findOneAndReplace" ? "replace" : "delete";
      return `This ${command.kind} has no effective filter and will ${verb} an arbitrary document in ${command.collection}.`;
    }
    case "bulkWrite":
      return bulkWriteFilters(command.operations).some(mongoFilterIsEffectivelyUnbounded) ? `This bulkWrite contains an operation with no effective filter, which can affect every document in ${command.collection}.` : null;
    case "dropCollection":
      return `This drops the ${command.collection} collection and all of its documents.`;
    case "inDatabase":
      // db.getSiblingDB("x").coll.deleteMany({}) is just as destructive as the unwrapped form.
      return describeMongoWriteRisk(command.command);
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Span placement
 * ------------------------------------------------------------------ */

/** Underline the part the message is about when it can be found in the text; otherwise the command head. */
function errorSpan(source: string, segment: MongoTextRange, message: string): SqlTextSpan {
  const text = segment.text;

  const constructor = /Unsupported value (?:new )?([A-Za-z_$][\w$]*)\(\.\.\.\)/.exec(message);
  if (constructor) {
    const callIndex = indexOutsideStrings(text, new RegExp(`\\b${escapeRegExp(constructor[1]!)}\\s*\\(`));
    if (callIndex >= 0) {
      const openIndex = text.indexOf("(", callIndex);
      const closeIndex = findMatchingParen(text, openIndex);
      return spanFor(source, segment.from + callIndex, segment.from + (closeIndex >= 0 ? closeIndex + 1 : openIndex + 1));
    }
  }

  const operator = /must not contain update operators such as (\$[A-Za-z]+)/.exec(message);
  if (operator) {
    const keyIndex = indexOutsideStrings(text, new RegExp(escapeRegExp(operator[1]!)));
    if (keyIndex >= 0) return spanFor(source, segment.from + keyIndex, segment.from + keyIndex + operator[1]!.length);
  }

  const trailing = /Unexpected text after [^:]+: "(.+)"\.$/.exec(message);
  if (trailing) {
    const tailIndex = text.lastIndexOf(trailing[1]!.replace(/…$/, ""));
    if (tailIndex >= 0) return spanFor(source, segment.from + tailIndex, segment.to);
  }

  return headSpan(source, segment);
}

function headSpan(source: string, segment: MongoTextRange): SqlTextSpan {
  const text = segment.text;
  const leading = text.length - text.trimStart().length;
  const head = COMMAND_HEAD.exec(text);
  const headEnd = head && head[0].trim() ? head[0].length : text.indexOf("\n", leading) === -1 ? text.length : text.indexOf("\n", leading);
  return spanFor(source, segment.from + leading, segment.from + Math.max(headEnd, leading + 1));
}

/** 1-based line/column span for the absolute offsets [from, to). `end_column` is inclusive. */
function spanFor(source: string, from: number, to: number): SqlTextSpan {
  const start = lineColumnAt(source, from);
  const end = lineColumnAt(source, Math.max(to - 1, from));
  return { start_line: start.line, start_column: start.column, end_line: end.line, end_column: end.column };
}

function lineColumnAt(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function indexOutsideStrings(text: string, pattern: RegExp): number {
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (pattern.test(text.slice(index)) && text.slice(index).search(pattern) === 0) return index;
  }
  return -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
