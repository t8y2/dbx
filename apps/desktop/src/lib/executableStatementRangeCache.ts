import type { Text } from "@codemirror/state";
import type { DatabaseType } from "@/types/database";
import { executableStatementRanges, type SqlTextRange } from "@/lib/sqlStatementRanges";

export interface ExecutableStatementRangeCache {
  doc: Text;
  databaseType?: DatabaseType;
  byStart: Map<number, SqlTextRange>;
}

export type ExecutableStatementRangeParser = (sql: string, databaseType?: DatabaseType) => SqlTextRange[];

export function executableStatementRangeCacheForDoc(cache: ExecutableStatementRangeCache | null, doc: Text, databaseType?: DatabaseType, parse: ExecutableStatementRangeParser = executableStatementRanges): ExecutableStatementRangeCache {
  if (cache?.doc === doc && cache.databaseType === databaseType) return cache;

  const byStart = new Map<number, SqlTextRange>();
  for (const range of parse(doc.toString(), databaseType)) {
    byStart.set(range.from, range);
  }
  return { doc, databaseType, byStart };
}

export function executableStatementRangeStartingAt(cache: ExecutableStatementRangeCache, lineFrom: number): SqlTextRange | null {
  return cache.byStart.get(lineFrom) ?? null;
}
