import { buildSqlParserErrorDiagnostic, sqlTextSpanToOffsetRange, type SqlSemanticDiagnostic } from "@/lib/sql/semantic/diagnostics";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import type { SqlReferenceAnalysis, SqlTextSpan } from "@/types/database";

const KEYWORDS = "SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL ON USING GROUP BY ORDER HAVING LIMIT OFFSET FETCH UNION INTERSECT EXCEPT INSERT INTO VALUES UPDATE SET DELETE CREATE ALTER DROP TRUNCATE EXPLAIN WITH RETURNING DISTINCT".split(" ");
const MAX_REPAIR_ATTEMPTS = 3;

function isSingleEdit(left: string, right: string): boolean {
  if (left === right || Math.abs(left.length - right.length) > 1) return false;
  let index = 0;
  while (index < left.length && left[index] === right[index]) index++;
  if (left.length === right.length) {
    return left.slice(index + 1) === right.slice(index + 1) || (left[index] === right[index + 1] && left[index + 1] === right[index] && left.slice(index + 2) === right.slice(index + 2));
  }
  return left.length < right.length ? left.slice(index) === right.slice(index + 1) : left.slice(index + 1) === right.slice(index);
}

export interface SqlDiagnosticReferenceAnalysis {
  analysis: SqlReferenceAnalysis;
  keywordDiagnostic?: SqlSemanticDiagnostic;
}

/**
 * Recover one misspelled keyword for diagnostics only. The original SQL must
 * fail parsing and a replacement must parse in the same dialect before it is
 * accepted. Valid identifiers and aliases never enter the recovery path.
 */
export async function analyzeSqlDiagnosticReferences(sql: string, dialect: string, analyze: (sql: string) => Promise<SqlReferenceAnalysis>): Promise<SqlDiagnosticReferenceAnalysis> {
  try {
    return { analysis: await analyze(sql) };
  } catch (error) {
    const diagnostic = buildSqlParserErrorDiagnostic(error, sql);
    const errorRange = diagnostic && sqlTextSpanToOffsetRange(sql, diagnostic.span);
    if (!diagnostic || !errorRange) throw error;

    const tokens = tokenizeSqlSemantic(sql, dialect).filter((token) => token.kind !== "comment");
    const errorIndex = tokens.findIndex((token) => token.span.end > errorRange.from);
    // Parsers may consume a typo as an alias and report the following token.
    const nearby = [tokens[errorIndex], tokens[errorIndex - 1]];
    let attempts = 0;
    for (const token of nearby) {
      if (token?.kind !== "word" || !/^[A-Za-z]{3,}$/.test(token.text)) continue;
      const word = token.text.toUpperCase();
      if (KEYWORDS.includes(word)) continue;
      for (const keyword of KEYWORDS) {
        if (!isSingleEdit(word, keyword)) continue;
        if (attempts++ >= MAX_REPAIR_ATTEMPTS) throw error;
        const repairedSql = sql.slice(0, token.span.start) + keyword + sql.slice(token.span.end);
        let analysis: SqlReferenceAnalysis;
        try {
          analysis = await analyze(repairedSql);
        } catch {
          continue;
        }

        const prefix = sql.slice(0, token.span.start).split("\n");
        const line = prefix.length;
        const column = prefix[prefix.length - 1]!.length + 1;
        const delta = keyword.length - token.text.length;
        const remap = (span: SqlTextSpan): SqlTextSpan => ({
          ...span,
          start_column: span.start_column - (span.start_line === line && span.start_column >= column + keyword.length ? delta : 0),
          end_column: span.end_column - (span.end_line === line && span.end_column >= column + keyword.length ? delta : 0),
        });
        return {
          analysis: {
            ...analysis,
            tables: analysis.tables.map((table) => ({ ...table, span: remap(table.span) })),
            columns: analysis.columns.map((column) => ({ ...column, span: remap(column.span) })),
            ...(analysis.group_by_violations && { group_by_violations: analysis.group_by_violations.map((violation) => ({ ...violation, span: remap(violation.span) })) }),
          },
          keywordDiagnostic: {
            message: `${token.text} → ${keyword}\n${diagnostic.message}`,
            severity: "error",
            span: { start_line: line, start_column: column, end_line: line, end_column: column + token.text.length - 1 },
          },
        };
      }
    }
    throw error;
  }
}
