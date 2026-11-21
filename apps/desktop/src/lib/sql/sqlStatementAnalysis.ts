import { EditorState, Text } from "@codemirror/state";
import * as langSql from "@codemirror/lang-sql";
import { ensureSyntaxTree } from "@codemirror/language";
import { createDbxCodeMirrorSqlDialect, type CodeMirrorSqlDialectName } from "@/lib/editor/codemirrorSqlDialect";
import { computeBlockFoldRanges, type FoldRange } from "@/lib/editor/codemirrorSqlBlockFolding";
import { executableStatementRangeCacheForDoc, type ExecutableStatementRangeCache } from "./executableStatementRangeCache";
import type { SqlParameterOptions } from "./sqlParameters";
import type { DatabaseType } from "@/types/database";

export interface SqlStatementAnalysisRequest {
  sql: string;
  databaseType?: DatabaseType;
  parameterOptions?: SqlParameterOptions;
  includeFolds?: boolean;
  syntaxDialect?: CodeMirrorSqlDialectName;
  driverProfile?: string;
}

export type SqlStatementAnalysisResult = Omit<ExecutableStatementRangeCache, "doc"> & { folds?: Map<number, FoldRange> };

export function analyzeSqlStatements(request: SqlStatementAnalysisRequest): SqlStatementAnalysisResult {
  const { doc: _doc, ...result } = executableStatementRangeCacheForDoc(null, Text.of(request.sql.split("\n")), request.databaseType, request.parameterOptions);
  if (request.includeFolds) {
    const state = EditorState.create({ doc: request.sql, extensions: [langSql.sql({ dialect: createDbxCodeMirrorSqlDialect(langSql, request.syntaxDialect ?? "mysql", request.databaseType, request.driverProfile) })] });
    let tree = ensureSyntaxTree(state, state.doc.length, 1000);
    while (!tree) tree = ensureSyntaxTree(state, state.doc.length, 1000);
    return { ...result, folds: computeBlockFoldRanges(state, request.databaseType, tree) };
  }
  return result;
}
