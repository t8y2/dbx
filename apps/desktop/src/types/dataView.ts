import type { QueryResult } from "@/types/database";

export type DataViewDisplayMode = "table" | "chart";
export type DataViewVariableKind = "string" | "number" | "boolean" | "date";
export type DataViewInputType = "text" | "select";
export type DataViewQueryKind = "query" | "mutation";
export type DataViewChartType = "bar" | "line" | "pie";

export interface DataViewChartConfig {
  type?: DataViewChartType;
  /** Column name used for the X axis (or pie slice labels). */
  xColumn?: string;
  /** Column names plotted as Y-axis series (or pie slice values, first wins). */
  yColumns?: string[];
}

/** A query's position and size in the Runner's 12-column dashboard grid. */
export interface DataViewGridPos {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A shared variable exposed to the runner; every sub-query resolves its
 *  `${name}` placeholders from this view-level set. */
export interface DataViewVariable {
  name: string;
  label?: string;
  kind?: DataViewVariableKind;
  inputType?: DataViewInputType;
  options?: string[];
  required?: boolean;
  defaultValue?: string | null;
}

export interface DataViewQuery {
  id: string;
  title?: string;
  connectionId: string;
  database?: string;
  catalog?: string | null;
  schema?: string | null;
  sqlTemplate: string;
  /** `query` (read, default) or `mutation` (write). */
  kind?: DataViewQueryKind;
  displayMode?: DataViewDisplayMode | null;
  chartConfig?: DataViewChartConfig | null;
  orderIndex?: number;
  /** Runner dashboard-grid placement; absent until the user first edits the layout. */
  gridPos?: DataViewGridPos | null;
}

export interface DataView {
  id: string;
  name: string;
  description?: string | null;
  defaultDisplayMode: DataViewDisplayMode;
  queries: DataViewQuery[];
  variables: DataViewVariable[];
  ownerId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DataViewSummary {
  id: string;
  name: string;
  description?: string | null;
  defaultDisplayMode: DataViewDisplayMode;
  queryCount: number;
  ownerId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DataViewParamValue {
  kind: string;
  value: string;
}

export interface DataViewQueryResult {
  queryId: string;
  title: string;
  displayMode: DataViewDisplayMode;
  result?: QueryResult | null;
  /** Raw Redis command result value, present instead of `result` for Redis queries. */
  redisValue?: unknown;
  error?: string | null;
}

export interface ExecuteDataViewResponse {
  results: DataViewQueryResult[];
}

export interface ExecuteDataViewOptions {
  maxRows?: number;
  timeoutSecs?: number;
  clientSessionId?: string;
  queryIds?: string[];
  /** Must be true to execute any query whose `kind === "mutation"`. The Editor's
   *  single-query Preview passes false for `mutation` rows so the backend rejects
   *  the call unless the user has confirmed via the danger dialog. */
  allowMutations?: boolean;
}
