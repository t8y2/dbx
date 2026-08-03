import type { Text } from "@codemirror/state";
import type { DatabaseType } from "@/types/database";
import { readSqlBracedParameterAt, type SqlParameterOptions } from "@/lib/sql/sqlParameters";
import { executableStatementRanges, type SqlTextRange } from "@/lib/sql/sqlStatementRanges";
import { cursorBelongsToTrailingStatementDelimiter } from "@/lib/sql/statementDelimiter";

export interface ExecutableStatementRangeCache {
  doc: Text;
  databaseType?: DatabaseType;
  parameterOptions?: SqlParameterOptions;
  parameterSyntaxKey: string;
  byStart: Map<number, SqlTextRange>;
  byExecutableLineStart: Map<number, SqlTextRange>;
  ranges: SqlTextRange[];
}

export type ExecutableStatementRangeParser = (sql: string, databaseType?: DatabaseType, parameterOptions?: SqlParameterOptions) => SqlTextRange[];

export function executableStatementRangeCacheForDoc(
  cache: ExecutableStatementRangeCache | null,
  doc: Text,
  databaseType?: DatabaseType,
  parameterOptionsOrParse?: SqlParameterOptions | ExecutableStatementRangeParser,
  customParse: ExecutableStatementRangeParser = executableStatementRanges,
): ExecutableStatementRangeCache {
  const parameterOptions = typeof parameterOptionsOrParse === "function" ? undefined : parameterOptionsOrParse;
  const parse = typeof parameterOptionsOrParse === "function" ? parameterOptionsOrParse : customParse;
  const parameterSyntaxKey = parameterOptions?.enabledSyntaxes ? parameterOptions.enabledSyntaxes.join(",") : "*";
  if (cache?.doc === doc && cache.databaseType === databaseType && cache.parameterSyntaxKey === parameterSyntaxKey) return cache;

  const byStart = new Map<number, SqlTextRange>();
  const byExecutableLineStart = new Map<number, SqlTextRange>();
  const ranges = parse(doc.toString(), databaseType, parameterOptions);
  for (const range of ranges) {
    byStart.set(range.from, range);
    const line = doc.lineAt(range.from);
    if (doc.sliceString(line.from, range.from).trim() === "") {
      byExecutableLineStart.set(line.from, range);
    }
  }
  return { doc, databaseType, parameterOptions, parameterSyntaxKey, byStart, byExecutableLineStart, ranges };
}

export function executableStatementRangeStartingAt(cache: ExecutableStatementRangeCache, lineFrom: number): SqlTextRange | null {
  return cache.byStart.get(lineFrom) ?? cache.byExecutableLineStart.get(lineFrom) ?? null;
}

export function executableStatementRangeAtCursor(cache: ExecutableStatementRangeCache, cursorPos: number): SqlTextRange | null {
  const pos = Math.max(0, Math.min(cursorPos, cache.doc.length));
  const line = cache.doc.lineAt(pos);
  const lineText = line.text.trim();
  const lineContentStart = line.from + line.text.search(/\S|$/);
  const startsHashComment = lineText.startsWith("#") && readSqlBracedParameterAt(cache.doc.toString(), lineContentStart, cache.parameterOptions)?.syntax !== "mybatis";
  if (!lineText || lineText.startsWith("--") || startsHashComment || isCursorOnLeadingBlockComment(line.text, pos - line.from)) return null;

  for (let index = 0; index < cache.ranges.length; index += 1) {
    const range = cache.ranges[index];
    if (pos >= range.from && pos <= range.to) return range;

    if (pos < range.from && range.from <= line.to && cache.doc.sliceString(pos, range.from).trim() === "") {
      return range;
    }

    const next = cache.ranges[index + 1];
    if (pos > range.to && (!next || pos < next.from) && cursorBelongsToTrailingStatementDelimiter(cache.doc, range.to, pos)) {
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
