import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import * as langSql from "@codemirror/lang-sql";
import { createDbxCodeMirrorSqlDialect, type CodeMirrorSqlDialectName } from "@/lib/editor/codemirrorSqlDialect";
import { extractCteDefinitions, getSqlCompletionContext, getPostgresSequenceLiteralCompletionContext, isSqlCompletionSuppressedContext, shouldAutoOpenSqlCompletion, type SqlCompletionContext } from "@/lib/sql/sqlCompletion";
import { oracleDatabaseLinkCompletionContext } from "./oracleDatabaseLinkCompletion";
import { resolveSqlServerUseDatabaseCompletion } from "./sqlCompletionLookupTarget";
import { sqlCompletionContextFromSemantic } from "@/lib/sql/semantic/completion";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";
import type { DatabaseType } from "@/types/database";
import type { SqlSemanticBuildOptions } from "./semantic/types";

export interface SqlCompletionAnalysisRequest {
  sql: string;
  cursor: number;
  databaseType?: DatabaseType;
  dialect?: SqlSemanticBuildOptions["dialect"];
  semanticCompletionEnabled: boolean;
  driverProfile?: string;
  syntaxDialect?: CodeMirrorSqlDialectName;
}

export interface SqlCompletionAnalysisResult {
  completionContext: SqlCompletionContext;
  positionalEligible: boolean;
  suppressed: boolean;
  sequenceLiteralContext: ReturnType<typeof getPostgresSequenceLiteralCompletionContext>;
  databaseLinkContext: ReturnType<typeof oracleDatabaseLinkCompletionContext>;
  useDatabaseCompletion: ReturnType<typeof resolveSqlServerUseDatabaseCompletion>;
  cteDefinitions: ReturnType<typeof extractCteDefinitions>;
}

function minimalDocumentChange(previous: string, next: string): { from: number; to: number; insert: string } | null {
  if (previous === next) return null;
  const sharedLimit = Math.min(previous.length, next.length);
  let from = 0;
  while (from < sharedLimit && previous.charCodeAt(from) === next.charCodeAt(from)) from += 1;

  let previousTo = previous.length;
  let nextTo = next.length;
  while (previousTo > from && nextTo > from && previous.charCodeAt(previousTo - 1) === next.charCodeAt(nextTo - 1)) {
    previousTo -= 1;
    nextTo -= 1;
  }
  return { from, to: previousTo, insert: next.slice(from, nextTo) };
}

export class SqlCompletionAnalysisEngine {
  private state: EditorState | null = null;
  private document = "";
  private dialectKey = "";

  analyze(request: SqlCompletionAnalysisRequest): SqlCompletionAnalysisResult {
    return analyzeSqlCompletion(request, this.editorStateFor(request));
  }

  private editorStateFor(request: SqlCompletionAnalysisRequest): EditorState {
    const dialectName = request.syntaxDialect ?? (request.dialect === "doris" ? "mysql" : request.dialect) ?? "mysql";
    const dialectKey = `${request.databaseType ?? ""}:${dialectName}:${request.driverProfile ?? ""}`;
    if (!this.state || this.dialectKey !== dialectKey) {
      this.state = EditorState.create({
        doc: request.sql,
        extensions: [langSql.sql({ dialect: createDbxCodeMirrorSqlDialect(langSql, dialectName, request.databaseType, request.driverProfile) })],
      });
      this.document = request.sql;
      this.dialectKey = dialectKey;
    } else {
      const change = minimalDocumentChange(this.document, request.sql);
      if (change) this.state = this.state.update({ changes: change }).state;
      this.document = request.sql;
    }
    let tree = ensureSyntaxTree(this.state, this.state.doc.length, 250);
    while (!tree) tree = ensureSyntaxTree(this.state, this.state.doc.length, 250);
    if (tree !== syntaxTree(this.state)) this.state = this.state.update({}).state;
    return this.state;
  }
}

export function analyzeSqlCompletion(request: SqlCompletionAnalysisRequest, editorState?: EditorState): SqlCompletionAnalysisResult {
  const options = {
    databaseType: request.databaseType,
    dialect: request.dialect,
    editorState,
  };
  const legacyContext = getSqlCompletionContext(request.sql, request.cursor, options);
  const completionContext = request.semanticCompletionEnabled ? sqlCompletionContextFromSemantic(buildSqlSemanticModel(request.sql, request.cursor, options), legacyContext) : legacyContext;
  return {
    completionContext,
    positionalEligible: shouldAutoOpenSqlCompletion(request.sql, request.cursor, options, legacyContext),
    suppressed: isSqlCompletionSuppressedContext(request.sql, request.cursor, options),
    sequenceLiteralContext: getPostgresSequenceLiteralCompletionContext(request.sql, request.cursor, request.databaseType),
    databaseLinkContext: oracleDatabaseLinkCompletionContext(request.sql, request.cursor, request.databaseType),
    useDatabaseCompletion: resolveSqlServerUseDatabaseCompletion({ sql: request.sql, cursor: request.cursor, databaseType: request.databaseType }),
    cteDefinitions: extractCteDefinitions(request.sql),
  };
}
