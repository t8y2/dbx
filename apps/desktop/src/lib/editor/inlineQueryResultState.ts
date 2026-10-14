import type { QueryTab } from "@/types/database";
// Contract: new per-result view fields must be included here and tested when
// switching grids. Tab identity, SQL, transactions and cursor ownership are excluded.
// The original result panel keeps these fields on the tab. Each inline panel
// retains its own copy, and restores it before invoking the original actions.
export const inlineResultStateKeys = [
  "resultGridRevision",
  "resultSortColumn",
  "resultSortColumnIndex",
  "resultSortDirection",
  "resultSortMode",
  "resultSortedSql",
  "resultLocalSortOriginalRows",
  "resultLocalSortOriginalLargeValueCells",
  "resultLocalSortOriginalMongoDocuments",
  "resultLocalSortOriginalMongoCopyDocuments",
  "orderByInput",
  "structuredOrderByInput",
  "resultPageSql",
  "resultPageLimit",
  "resultPageOffset",
  "resultExecutedPageLimit",
  "resultExecutedPageOffset",
  "resultCountSql",
  "resultTotalRowCount",
  "resultTotalRowCountLoading",
  "resultPageJumpProgress",
  "queryAnalysis",
  "querySourceColumns",
  "queryWriteTargets",
  "queryDisplaySourceColumns",
  "queryEditabilityReason",
  "resultColumnComments",
  "mongoEditTarget",
  "tableMeta",
] as const satisfies readonly (keyof QueryTab)[];
export function captureInlineResultState(tab: QueryTab): Partial<QueryTab> {
  return Object.fromEntries(inlineResultStateKeys.map((key) => [key, tab[key]]));
}
