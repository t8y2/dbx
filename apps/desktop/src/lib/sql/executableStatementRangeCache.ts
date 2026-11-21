import { RangeSet, RangeValue, type ChangeSet, type Text } from "@codemirror/state";
import type { DatabaseType } from "@/types/database";
import type { SqlParameterOptions } from "@/lib/sql/sqlParameters";
import { executableStatementRanges, findSqlBlockCommentEnd, mysqlDelimiterAt, mysqlDelimiterPrefixAt, startsHashLineComment, statementParsingDatabaseType, type MysqlDelimiterCommand, type SqlTextRange } from "@/lib/sql/sqlStatementRanges";
import { cursorBelongsToTrailingStatementDelimiter } from "@/lib/sql/statementDelimiter";

export interface ExecutableStatementRangeCache {
  doc: Text;
  databaseType?: DatabaseType;
  parameterOptions?: SqlParameterOptions;
  parameterSyntaxKey: string;
  byStart: Map<number, SqlTextRange>;
  byExecutableLineStart: Map<number, SqlTextRange>;
  ranges: SqlTextRange[];
  mysqlDelimiterCommands: MysqlDelimiterCommand[];
}

/**
 * Membership-only view of the statement-start positions a run-statement gutter
 * needs (`byStart` keys plus `byExecutableLineStart` keys). Kept separate from
 * the full cache so it can be cheaply shifted through a ChangeSet on every
 * keystroke and fully rebuilt only after typing pauses, instead of re-parsing
 * the whole document synchronously per keystroke.
 */
export interface StatementGutterStartIndex {
  starts: RangeSet<StatementGutterStartMarker>;
  executableLineStarts: RangeSet<StatementGutterStartMarker>;
}

class StatementGutterStartMarker extends RangeValue {
  startSide = 1;
  endSide = 1;
}

const statementGutterStartMarker = new StatementGutterStartMarker();

function statementGutterStartRangeSet(positions: Iterable<number>): RangeSet<StatementGutterStartMarker> {
  return RangeSet.of(
    Array.from(new Set(positions), (position) => statementGutterStartMarker.range(position)),
    true,
  );
}

export function statementGutterStartIndexForCache(cache: ExecutableStatementRangeCache): StatementGutterStartIndex {
  return {
    starts: statementGutterStartRangeSet(cache.byStart.keys()),
    executableLineStarts: statementGutterStartRangeSet(cache.byExecutableLineStart.keys()),
  };
}

export function mapStatementGutterStartIndex(index: StatementGutterStartIndex, changes: ChangeSet): StatementGutterStartIndex {
  return { starts: index.starts.map(changes), executableLineStarts: index.executableLineStarts.map(changes) };
}

export function statementGutterStartIndexHasStartAt(index: StatementGutterStartIndex, lineFrom: number): boolean {
  return rangeSetHasPointAt(index.starts, lineFrom) || rangeSetHasPointAt(index.executableLineStarts, lineFrom);
}

function rangeSetHasPointAt(ranges: RangeSet<StatementGutterStartMarker>, position: number): boolean {
  const cursor = ranges.iter(position);
  return cursor.value !== null && cursor.from === position;
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
  const parameterSyntaxKey = `${parameterOptions?.enabledSyntaxes ? parameterOptions.enabledSyntaxes.join(",") : "*"}|compat=${parameterOptions?.compatibilityMode?.trim().toUpperCase() ?? ""}`;
  if (cache?.doc === doc && cache.databaseType === databaseType && cache.parameterSyntaxKey === parameterSyntaxKey) return cache;

  const byStart = new Map<number, SqlTextRange>();
  const byExecutableLineStart = new Map<number, SqlTextRange>();
  const sql = doc.toString();
  const mysqlDelimiterCommands: MysqlDelimiterCommand[] = [];
  const ranges = parse === executableStatementRanges ? executableStatementRanges(sql, databaseType, parameterOptions, mysqlDelimiterCommands) : parse(sql, databaseType, parameterOptions);
  let currentLine = doc.lines > 0 ? doc.line(1) : null;
  for (const range of ranges) {
    byStart.set(range.from, range);
    if (!currentLine || currentLine.to < range.from || currentLine.from > range.from) {
      currentLine = doc.lineAt(range.from);
    }
    if (doc.sliceString(currentLine.from, range.from).trim() === "") {
      byExecutableLineStart.set(currentLine.from, range);
    }
    const executableStart = executableStartAfterLeadingComments(sql, range, databaseType, parameterOptions);
    if (executableStart !== null) {
      byExecutableLineStart.set(doc.lineAt(executableStart).from, range);
    }
  }
  return { doc, databaseType, parameterOptions, parameterSyntaxKey, byStart, byExecutableLineStart, ranges, mysqlDelimiterCommands };
}

export function executableScriptFromStatement(cache: ExecutableStatementRangeCache, startIndex: number, position: number): SqlTextRange | null {
  const remaining = cache.ranges.slice(startIndex);
  const first = remaining[0];
  if (!first) return null;

  const line = cache.doc.lineAt(position);
  const clickedDirective = cache.mysqlDelimiterCommands.some((command) => command.from >= line.from && command.to <= line.to && command.to <= first.from);
  let from = clickedDirective ? line.from : first.from;
  const prefix = clickedDirective ? "" : mysqlDelimiterPrefixAt(cache.mysqlDelimiterCommands, first.from);
  const sql = prefix + cache.doc.sliceString(from);
  // Place the synthetic directive before the suffix so each executable
  // statement still maps to its original editor offset.
  from -= prefix.length;
  const ranges = executableStatementRanges(sql, cache.databaseType, cache.parameterOptions);
  if (ranges.length !== remaining.length || ranges.some((range, index) => from + range.from !== remaining[index].from || from + range.to !== remaining[index].to)) return null;
  return { sql, from, to: cache.doc.length };
}

function executableStartAfterLeadingComments(sql: string, range: SqlTextRange, databaseType?: DatabaseType, parameterOptions?: SqlParameterOptions): number | null {
  databaseType = statementParsingDatabaseType(databaseType, parameterOptions);
  const text = range.sql;
  const hasExecutableDirective = text.startsWith("/*+") || text.startsWith("/*@") || text.startsWith("/*&") || (databaseType === "mysql" && text.startsWith("/*proxy*/"));
  const hasModuleComment = databaseType === "sqlserver" && (text.startsWith("--") || text.startsWith("/*"));
  if (!hasExecutableDirective && !hasModuleComment) return null;

  let offset = 0;
  while (offset < text.length) {
    while (/\s/.test(text[offset] ?? "")) offset += 1;

    if (text.startsWith("/*", offset)) {
      const close = findSqlBlockCommentEnd(text, offset, databaseType);
      if (close < 0) return null;
      offset = close + 2;
      continue;
    }

    if (text.startsWith("--", offset)) {
      const newline = text.indexOf("\n", offset + 2);
      if (newline < 0) return null;
      offset = newline + 1;
      continue;
    }

    if (startsHashLineComment(sql, range.from + offset, databaseType, parameterOptions)) {
      const newline = text.indexOf("\n", offset + 1);
      if (newline < 0) return null;
      offset = newline + 1;
      continue;
    }

    return offset < text.length ? range.from + offset : null;
  }

  return null;
}

export function executableStatementRangeStartingAt(cache: ExecutableStatementRangeCache, lineFrom: number): SqlTextRange | null {
  return cache.byStart.get(lineFrom) ?? cache.byExecutableLineStart.get(lineFrom) ?? null;
}

export function executableStatementRangeAtCursor(cache: ExecutableStatementRangeCache, cursorPos: number): SqlTextRange | null {
  const pos = Math.max(0, Math.min(cursorPos, cache.doc.length));
  const line = cache.doc.lineAt(pos);
  const lineText = line.text.trim();
  const lineContentStart = line.from + line.text.search(/\S|$/);
  const startsHashComment = lineText.startsWith("#") && startsHashLineComment(cache.doc.toString(), lineContentStart, statementParsingDatabaseType(cache.databaseType, cache.parameterOptions), cache.parameterOptions);
  if (!lineText || lineText.startsWith("--") || startsHashComment || isCursorOnLeadingBlockComment(line.text, pos - line.from)) return null;

  for (let index = 0; index < cache.ranges.length; index += 1) {
    const range = cache.ranges[index];
    if (pos >= range.from && pos <= range.to) return range;

    if (pos < range.from && range.from <= line.to && cache.doc.sliceString(pos, range.from).trim() === "") {
      return range;
    }

    const next = cache.ranges[index + 1];
    if (pos > range.to && (!next || pos < next.from)) {
      const delimiter = mysqlDelimiterAt(cache.mysqlDelimiterCommands, range.from);
      if (cursorBelongsToTrailingStatementDelimiter(cache.doc, range.to, pos, delimiter)) return range;
      if (isCursorOnRangeEndLine(cache.doc, pos, range.to)) return range;
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

function isCursorOnRangeEndLine(doc: Text, pos: number, rangeTo: number): boolean {
  const line = doc.lineAt(pos);
  return rangeTo >= line.from && rangeTo <= line.to;
}
