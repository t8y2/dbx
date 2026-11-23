import type { AiAction } from "@/lib/ai/ai";
import { AI_QUERY_RESULT_PREVIEW_LIMITS, resolveAiContextLimits } from "@/lib/ai/aiContextLimits";
import { truncateTextAttachmentContent, type AiSelectionContextInput } from "@/lib/ai/aiAttachments";
import type { AiConversationBinding } from "@/lib/ai/aiConversationBinding";
import type { QueryTab } from "@/types/database";
import { isQueryExecutionErrorResult } from "@/lib/query/queryResultError";
import { queryResultExecutionSql } from "@/lib/tabs/tabPresentation";

/** Capture the displayed result's SQL before the panel loads or the editor changes. */
export function queryErrorSelection(tab: Pick<QueryTab, "title" | "result" | "resultSortedSql" | "resultBaseSql" | "lastExecutedSql"> | undefined): AiSelectionContextInput | undefined {
  const sql = tab ? queryResultExecutionSql({ ...tab, sql: "" }) : "";
  return sql?.trim() ? { source: "query-error", label: tab?.title, content: sql } : undefined;
}

/**
 * Resolved budgets for the result preview. Resolution is module-scope because
 * Phase 1 has no overrides; a future setting source should resolve once where
 * the request is built and pass the values down rather than re-resolving per
 * cell here.
 */
const AI_CONTEXT_LIMITS = resolveAiContextLimits();
/** Rows/value caps keep the preview useful instead of dumping a whole result page. */
const QUERY_RESULT_MAX_ROWS = AI_CONTEXT_LIMITS.queryResultMaxRows;
const QUERY_RESULT_MAX_VALUE_CHARS = AI_QUERY_RESULT_PREVIEW_LIMITS.maxValueChars;
const QUERY_RESULT_MAX_SQL_CHARS = AI_QUERY_RESULT_PREVIEW_LIMITS.maxSqlChars;
/**
 * Headroom below the selection budget applied by `createSelectionContext`
 * (12 000 chars): the footer names the omitted rows, and a selection the model
 * only sees a hard-truncated prefix of is worse than a smaller honest preview.
 */
const QUERY_RESULT_BUDGET_CHARS = AI_CONTEXT_LIMITS.queryResultBudgetChars;
/**
 * The header is composed of unbounded input (column names/types), so each
 * section is bounded on its own. Without this a very wide table or one long
 * column name could exceed the whole budget, leaving zero rows and pushing the
 * truncation footer past the downstream hard truncation.
 */
const QUERY_RESULT_MAX_COLUMN_CHARS = AI_QUERY_RESULT_PREVIEW_LIMITS.maxColumnChars;
const QUERY_RESULT_COLUMN_BUDGET_CHARS = AI_QUERY_RESULT_PREVIEW_LIMITS.columnBudgetChars;
/** One wide row must still be sendable, so it is clipped instead of dropped. */
const QUERY_RESULT_MAX_LINE_CHARS = AI_QUERY_RESULT_PREVIEW_LIMITS.maxLineChars;
/**
 * Column section entries may be up to 200 chars, which inside a row line would
 * still consume most of the line before the `=`: one pathological label would
 * then clip the line inside the name and leave the model with no cell value at
 * all. Row-line labels get their own, smaller cap.
 */
const QUERY_RESULT_MAX_ROW_LABEL_CHARS = AI_QUERY_RESULT_PREVIEW_LIMITS.maxRowLabelChars;
/** Marks a row line that stopped before every column was written out. */
const QUERY_RESULT_CLIP_MARKER = ", …";
/**
 * Space held back for the `Rows (showing X of Y loaded):` prefix and the
 * `(Result truncated: N more ...)` footer, so those are never the parts the
 * budget pushes out.
 */
const QUERY_RESULT_RESERVED_TAIL_CHARS = AI_QUERY_RESULT_PREVIEW_LIMITS.reservedTailChars;

function previewCellValue(value: unknown): string {
  const raw = JSON.stringify(value ?? null);
  return raw.length > QUERY_RESULT_MAX_VALUE_CHARS ? `${raw.slice(0, QUERY_RESULT_MAX_VALUE_CHARS)}…` : raw;
}

/**
 * One `- name (TYPE)` entry, clipped so a pathological identifier cannot eat the
 * whole column section (and with it every row).
 */
function previewColumnEntry(column: string, type: string | undefined): string {
  const entry = `- ${column}${type ? ` (${type})` : ""}`;
  return entry.length > QUERY_RESULT_MAX_COLUMN_CHARS ? `${truncateTextAttachmentContent(entry, QUERY_RESULT_MAX_COLUMN_CHARS - 1)}…` : entry;
}

/** A column label as used inside a row line, capped so one label cannot fill the line. */
function previewRowLabel(column: string): string {
  return column.length > QUERY_RESULT_MAX_ROW_LABEL_CHARS ? `${truncateTextAttachmentContent(column, QUERY_RESULT_MAX_ROW_LABEL_CHARS - 1)}…` : column;
}

/**
 * Builds one row line cell by cell so the clip always lands on a cell boundary.
 * Clipping the already-joined line instead could stop inside a pathological
 * column name, before its `=value`, which left the model with a "Rows" section
 * that contained no cell value at all.
 */
function previewRowLine(columns: readonly string[], row: readonly unknown[], index: number): string {
  const prefix = `#${index + 1}: `;
  const limit = QUERY_RESULT_MAX_LINE_CHARS - QUERY_RESULT_CLIP_MARKER.length;
  const cells: string[] = [];
  let used = prefix.length;
  let clipped = false;
  for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
    const cell = `${previewRowLabel(columns[columnIndex])}=${previewCellValue(row[columnIndex])}`;
    const separator = cells.length ? 2 : 0;
    if (used + separator + cell.length > limit) {
      clipped = true;
      break;
    }
    cells.push(cell);
    used += separator + cell.length;
  }
  if (!cells.length) {
    // Theoretical guard (only reachable with a line budget far below the label
    // cap): still send a `label=value` pair instead of a bare column name.
    const label = previewRowLabel(columns[0] ?? "");
    const value = previewCellValue(row[0]);
    const room = Math.max(0, limit - prefix.length - label.length - 1);
    cells.push(`${label}=${value.length <= room ? value : `${truncateTextAttachmentContent(value, Math.max(0, room - 1))}…`}`);
    clipped = true;
  }
  return `${prefix}${cells.join(", ")}${clipped ? QUERY_RESULT_CLIP_MARKER : ""}`;
}

/**
 * Bounded snapshot of the displayed result, attached only when the user
 * explicitly asks for it ("Send result to AI"). Row data therefore never rides
 * along with an ordinary request: the global `includeQueryResult` setting and
 * its privacy default are untouched.
 */
export function queryResultSelection(tab: Pick<QueryTab, "title" | "result" | "resultSortedSql" | "resultBaseSql" | "lastExecutedSql"> | undefined): AiSelectionContextInput | undefined {
  const result = tab?.result;
  if (!result || isQueryExecutionErrorResult(result) || !result.columns.length || !result.rows.length) return undefined;
  const rawSql = queryResultExecutionSql({ ...tab, sql: "" }).trim();
  const sql = rawSql.length > QUERY_RESULT_MAX_SQL_CHARS ? `${rawSql.slice(0, QUERY_RESULT_MAX_SQL_CHARS)}…` : rawSql;

  // The column section is bounded on its own: names and types come from the
  // database and have no length limit, and an unbounded header would starve
  // every row (and could even crowd out the truncation footer downstream).
  const columnEntries: string[] = [];
  let columnSectionLength = 0;
  for (let index = 0; index < result.columns.length; index++) {
    const entry = previewColumnEntry(result.columns[index], result.column_types?.[index]);
    if (columnEntries.length && columnSectionLength + entry.length > QUERY_RESULT_COLUMN_BUDGET_CHARS) break;
    columnEntries.push(entry);
    columnSectionLength += entry.length + 1;
  }
  const omittedColumns = result.columns.length - columnEntries.length;
  if (omittedColumns > 0) columnEntries.push(`… (${omittedColumns} more column(s) not listed)`);
  const columns = columnEntries.join("\n");
  const header = [sql ? `Executed SQL:\n${sql}` : "", `Columns (${result.columns.length}):\n${columns}`, `Loaded rows: ${result.rows.length}`].filter(Boolean).join("\n\n");

  const rows: string[] = [];
  let rowsLength = 0;
  const rowLimit = Math.min(result.rows.length, QUERY_RESULT_MAX_ROWS);
  for (let index = 0; index < rowLimit; index++) {
    // Clipped rather than dropped: one wide row must not block itself or the
    // rows after it. The reserved tail keeps the row-count prefix and the
    // truncation footer inside the budget, so the footer is never pushed out.
    const line = previewRowLine(result.columns, result.rows[index], index);
    const separator = rows.length ? 1 : 0;
    if (header.length + rowsLength + separator + line.length + QUERY_RESULT_RESERVED_TAIL_CHARS > QUERY_RESULT_BUDGET_CHARS) break;
    rows.push(line);
    rowsLength += separator + line.length;
  }

  const parts = [header];
  if (rows.length) parts.push(`Rows (showing ${rows.length} of ${result.rows.length} loaded):\n${rows.join("\n")}`);
  const omitted = result.rows.length - rows.length;
  if (omitted > 0) parts.push(`(Result truncated: ${omitted} more loaded row(s) not sent.)`);
  return { source: "query-result", label: tab?.title, content: parts.join("\n\n") };
}

/**
 * Request shape shared by every AI entry point that lives *outside* the panel
 * (#10058 R1/R3): the editor's "Send to AI", the query-result "Fix with AI"
 * button, and the object tree's "Add to AI".
 *
 * The point of one shape is that all three resolve their target through the same
 * rule (`resolveExternalSendTarget`) instead of each growing its own: a
 * trigger from namespace B either reuses a chat already on B or opens a new chat
 * bound to B — it never rewrites the binding of an existing conversation
 * (#9902), which is what made one connection global before.
 */
export interface AiExternalContextRequest {
  /**
   * Namespace of the surface that triggered the request. `null` means it could
   * not be resolved (typically the tab's connection was deleted while the SQL
   * tab stayed open): the request must then degrade to an explicitly unbound
   * chat and tell the user, never quietly keep the previous binding (R6).
   */
  target: AiConversationBinding | null;
  /** Selections taken from that surface, attached as context data (R4/R8). */
  selections?: readonly AiSelectionContextInput[];
  /** Tables the gesture referred to — the object tree's "Add to AI". */
  tableMentions?: readonly { database?: string; schema?: string; table: string }[];
  /** Action to run immediately (query-result "Fix with AI"); omitted = fill the composer only. */
  action?: AiAction;
  /** Instruction text handed to `action`. */
  instruction?: string;
  /** i18n key of the toast shown when `target` could not be resolved. */
  unresolvedKey?: string;
}
