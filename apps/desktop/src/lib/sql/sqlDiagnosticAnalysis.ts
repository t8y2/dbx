import type { DatabaseType, SqlReferenceAnalysis } from "@/types/database";
import { buildOracleSyntaxDiagnostics } from "./oracleSyntaxDiagnostics";
import { analyzeMysqlRoutineSyntax, supportsMysqlRoutineSyntaxDiagnostics } from "./mysqlRoutineSyntaxDiagnostics";
import { buildSqlServerRoutineSyntaxDiagnostics } from "./sqlServerRoutineSyntaxDiagnostics";
import { isSqlSemanticDiagnosticInputContext, shouldRunSqlSemanticDiagnostics, sqlSemanticDiagnosticRangesForViewport, sqlServerRoutineDefinitionRangesForViewport } from "./semantic/diagnostics";
import { buildSqlSemanticModel } from "./semantic/model";
import { mergeSqlSemanticReferenceAnalysis } from "./semantic/references";
import type { SqlSemanticBuildOptions } from "./semantic/types";
import type { SqlParameterOptions } from "./sqlParameters";

export interface SqlDiagnosticAnalysisRequest {
  sql: string;
  cursor: number;
  databaseType?: DatabaseType;
  dialect?: SqlSemanticBuildOptions["dialect"];
  driverProfile?: string;
  parameterOptions?: SqlParameterOptions;
  visibleRanges: readonly { from: number; to: number }[];
  referenceAnalysis?: SqlReferenceAnalysis;
}

export function analyzeSqlDiagnosticDocument(request: SqlDiagnosticAnalysisRequest) {
  const { sql, cursor, databaseType, visibleRanges, parameterOptions } = request;
  const shouldRun = shouldRunSqlSemanticDiagnostics(sql, cursor, { databaseType });
  const diagnosticRanges = shouldRun ? sqlSemanticDiagnosticRangesForViewport(sql, visibleRanges, databaseType, undefined, parameterOptions) : [];
  const sqlServerRoutineRanges = shouldRun && databaseType === "sqlserver" ? sqlServerRoutineDefinitionRangesForViewport(sql, visibleRanges) : [];
  return {
    shouldRun,
    inputContext: shouldRun && isSqlSemanticDiagnosticInputContext(sql, cursor, { databaseType }),
    diagnosticRanges,
    sqlServerRoutineRanges,
    oracleSyntaxDiagnostics: shouldRun ? buildOracleSyntaxDiagnostics(sql, databaseType) : [],
    mysqlRoutineAnalysis: shouldRun && databaseType === "mysql" && supportsMysqlRoutineSyntaxDiagnostics(request.driverProfile) ? analyzeMysqlRoutineSyntax(sql) : null,
    sqlServerRoutineDiagnostics: sqlServerRoutineRanges.map((range) => buildSqlServerRoutineSyntaxDiagnostics(range.sql, databaseType)),
  };
}

export interface SqlDiagnosticAnalysisResult {
  document?: ReturnType<typeof analyzeSqlDiagnosticDocument>;
  referenceAnalysis?: SqlReferenceAnalysis;
}

export function analyzeSqlDiagnostics(request: SqlDiagnosticAnalysisRequest): SqlDiagnosticAnalysisResult {
  if (request.referenceAnalysis) {
    return { referenceAnalysis: mergeSqlSemanticReferenceAnalysis(request.referenceAnalysis, buildSqlSemanticModel(request.sql, request.cursor, { databaseType: request.databaseType, dialect: request.dialect })) };
  }
  return { document: analyzeSqlDiagnosticDocument(request) };
}
