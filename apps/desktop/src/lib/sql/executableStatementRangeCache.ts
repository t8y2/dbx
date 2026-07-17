import type { Text } from "@codemirror/state";
import type { DatabaseType } from "@/types/database";
import { executableStatementRanges, type SqlTextRange } from "@/lib/sql/sqlStatementRanges";

export interface ExecutableStatementRangeCache {
  doc: Text;
  databaseType?: DatabaseType;
  byStart: Map<number, SqlTextRange>;
  byExecutableLineStart: Map<number, SqlTextRange>;
  ranges: SqlTextRange[];
}

export type ExecutableStatementRangeParser = (sql: string, databaseType?: DatabaseType) => SqlTextRange[];

export function executableStatementRangeCacheForDoc(cache: ExecutableStatementRangeCache | null, doc: Text, databaseType?: DatabaseType, parse: ExecutableStatementRangeParser = executableStatementRanges): ExecutableStatementRangeCache {
  if (cache?.doc === doc && cache.databaseType === databaseType) return cache;

  const byStart = new Map<number, SqlTextRange>();
  const byExecutableLineStart = new Map<number, SqlTextRange>();
  const ranges = parse(doc.toString(), databaseType);
  for (const range of ranges) {
    byStart.set(range.from, range);
    const line = doc.lineAt(range.from);
    if (doc.sliceString(line.from, range.from).trim() === "") {
      byExecutableLineStart.set(line.from, range);
    }
  }
  return { doc, databaseType, byStart, byExecutableLineStart, ranges };
}

export function executableStatementRangeStartingAt(cache: ExecutableStatementRangeCache, lineFrom: number): SqlTextRange | null {
  return cache.byStart.get(lineFrom) ?? cache.byExecutableLineStart.get(lineFrom) ?? null;
}

export function executableStatementRangeAtCursor(cache: ExecutableStatementRangeCache, cursorPos: number): SqlTextRange | null {
  const pos = Math.max(0, Math.min(cursorPos, cache.doc.length));
  const line = cache.doc.lineAt(pos);
  const lineText = line.text.trim();
  if (!lineText || lineText.startsWith("--") || lineText.startsWith("#") || isCursorOnLeadingBlockComment(line.text, pos - line.from)) return null;

  for (let index = 0; index < cache.ranges.length; index += 1) {
    const range = cache.ranges[index];
    if (pos >= range.from && pos <= range.to) return range;

    if (pos < range.from && range.from <= line.to && cache.doc.sliceString(pos, range.from).trim() === "") {
      return range;
    }

    const next = cache.ranges[index + 1];
    if (pos > range.to && (!next || pos < next.from) && range.to >= line.from && range.to <= line.to && cursorRemainsOnRangeLine(cache.doc, range.to, pos)) {
      return range;
    }
  }

  return null;
}

function isCursorOnLeadingBlockComment(lineText: string, lineOffset: number): boolean {
  const commentStart = lineText.search(/\S/);
  if (commentStart < 0 || !lineText.startsWith("/*", commentStart)) return false;

  const commentEnd = lineText.indexOf("*/", commentStart + 2);
  if (commentEnd < 0) return true;
  const afterComment = lineText.slice(commentEnd + 2);
  if (!afterComment.trim()) return true;

  return lineOffset <= commentEnd + 2;
}

function cursorRemainsOnRangeLine(doc: Text, rangeTo: number, cursorPos: number): boolean {
  const between = doc.sliceString(rangeTo, cursorPos);
  if (between.includes("\n")) return false;
  const delimiterIndex = between.lastIndexOf(";");
  if (delimiterIndex === -1) return between.trim() === "";

  const beforeDelimiter = between.slice(0, delimiterIndex);
  const afterDelimiter = between.slice(delimiterIndex + 1);
  return beforeDelimiter.trim() === "" && afterDelimiter.trim() === "";
}
