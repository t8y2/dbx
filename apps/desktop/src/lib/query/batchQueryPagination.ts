import type { QueryPaginationExecutionPlan, QueryPaginationExecutionPlanOptions } from "@/lib/backend/tauri";
import type { SqlParameterOptions } from "@/lib/sql/sqlParameters";
import { splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";

export interface BatchQueryPaginationPlan {
  sql: string;
  statements: (QueryPaginationExecutionPlan | undefined)[];
}

/** Plan pages without splitting execution into separate connections or transactions. */
export async function prepareBatchQueryPagination(
  options: QueryPaginationExecutionPlanOptions,
  prepare: (options: QueryPaginationExecutionPlanOptions) => Promise<QueryPaginationExecutionPlan>,
  parameterOptions?: SqlParameterOptions,
  isCancelled?: () => boolean,
): Promise<BatchQueryPaginationPlan | undefined> {
  // Cursor drivers and T-SQL batches have execution-unit semantics that cannot
  // be replaced by independent SQL pages. Keep their existing execution path.
  if (options.useAgentCursor || options.databaseType === "sqlserver" || options.pagination.sessionId) return;
  const ranges = splitSqlStatementRanges(options.sql, options.databaseType, parameterOptions);
  if (ranges.length < 2) return;
  const statements: BatchQueryPaginationPlan["statements"] = [];
  let planningFailed = false;
  // Bound planning concurrency for large scripts; these calls only parse SQL.
  for (let start = 0; start < ranges.length; start += 4) {
    if (isCancelled?.()) throw new Error("Query canceled");
    const plans = await Promise.all(
      ranges.slice(start, start + 4).map(async (range) => {
        try {
          const plan = await prepare({ ...options, sql: range.sql, queryBaseSql: range.sql, firstPageUsesActualSql: false });
          // Non-SELECT statements and unsupported rewrites stay byte-for-byte
          // intact. Never turn a per-statement cursor into a batch cursor.
          if (!plan.pageSql || plan.pageLimit === undefined || plan.pageOffset === undefined || plan.useAgentResultSession || plan.paginationError) return undefined;
          // Some dialects return the original statement and rely on a driver row
          // cap. That is not server pagination. An unchanged explicit LIMIT is
          // safe only when the planner also proved its result bound.
          if (plan.pageSql.trim().replace(/;$/, "").trimEnd() === range.sql.trim().replace(/;$/, "").trimEnd() && plan.exactQueryRowBound === undefined) return undefined;
          return plan;
        } catch (error) {
          // Planning is an optimization for a batch. If one statement cannot
          // be planned because of a parser/backend compatibility issue, let the
          // caller execute the original batch so the other statements retain
          // their normal multi-statement semantics. Cancellation remains fatal.
          if (isCancelled?.()) throw error;
          planningFailed = true;
          return undefined;
        }
      }),
    );
    if (planningFailed) return;
    statements.push(...plans);
  }
  if (!statements.some(Boolean)) return;
  // Replace ranges, not delimiters/preambles: comments, client directives and
  // custom routine delimiters must retain their positions relative to the SQL.
  const chunks: string[] = [];
  let end = 0;
  ranges.forEach((range, index) => {
    const plan = statements[index];
    const executedSql = options.databaseType === "mysql" ? (plan?.pageProbeSql ?? plan?.sqlToExecute) : plan?.sqlToExecute;
    chunks.push(options.sql.slice(end, range.from), executedSql ? executedSql.trimEnd().replace(/;$/, "") : range.sql);
    end = range.to;
  });
  chunks.push(options.sql.slice(end));
  return { sql: chunks.join(""), statements };
}
