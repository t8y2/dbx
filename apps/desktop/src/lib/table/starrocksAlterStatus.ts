import type { QueryResult } from "@/types/database";
export const STARROCKS_ALTER_KINDS = ["COLUMN", "OPTIMIZE", "ROLLUP"] as const;
export type StarRocksAlterKind = (typeof STARROCKS_ALTER_KINDS)[number];
export interface StarRocksAlterJob {
  kind: StarRocksAlterKind;
  id: string;
  state: string;
  created: string;
  finished: string;
  message: string;
  progress?: number;
  sql?: string;
}
const terminalStates = new Set(["FINISHED", "CANCELLED"]);
export function isStarRocksAlterJobActive(job: StarRocksAlterJob): boolean {
  // Future/unknown states must not silently be treated as completion.
  return !terminalStates.has(job.state);
}
export function starRocksAlterStatusSql(kind: StarRocksAlterKind, table: string): string {
  if (!STARROCKS_ALTER_KINDS.includes(kind) || !table || /[\\\x00-\x1f]/.test(table)) throw new Error("Unsupported table name for ALTER status query");
  return `SHOW ALTER TABLE ${kind} WHERE TableName = '${table.replaceAll("'", "''")}' ORDER BY CreateTime DESC LIMIT 5;`;
}
export function parseStarRocksAlterJobs(kind: StarRocksAlterKind, result: Pick<QueryResult, "columns" | "rows">): StarRocksAlterJob[] {
  const names = result.columns.map((name) => name.toLowerCase());
  if (!names.includes("state") || !names.includes("jobid")) throw new Error("Unexpected SHOW ALTER result columns");
  return result.rows.map((row) => {
    const get = (name: string) => String(row[names.indexOf(name.toLowerCase())] ?? "");
    const progressText = get("Progress").trim();
    const numeric = /^(\d+(?:\.\d+)?)%$/.exec(progressText);
    const fraction = /^(\d+)\s*\/\s*(\d+)$/.exec(progressText);
    const progress = numeric ? Number(numeric[1]) : fraction && Number(fraction[2]) > 0 ? (Number(fraction[1]) / Number(fraction[2])) * 100 : undefined;
    return {
      kind,
      id: get("JobId"),
      state: get("State").toUpperCase(),
      created: get("CreateTime"),
      finished: get("FinishTime") || get("FinishedTime"),
      message: get("Msg"),
      sql: get("Sql") || get("Statement") || get("OriginalStmt") || undefined,
      progress: progress !== undefined && progress >= 0 && progress <= 100 ? Math.round(progress) : undefined,
    };
  });
}
export function recentStarRocksAlterJobs(jobs: StarRocksAlterJob[]): StarRocksAlterJob[] {
  return [...jobs].sort((a, b) => b.created.localeCompare(a.created) || b.id.localeCompare(a.id, undefined, { numeric: true })).slice(0, 5);
}
