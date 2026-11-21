/**
 * Opening the MCP call history from outside the history panel (Settings → MCP).
 * The app shell retains the request until the lazy history panel consumes it.
 */
export const MCP_CALL_HISTORY_OPEN_EVENT = "dbx:open-mcp-call-history";

export interface McpCallHistoryResource {
  connectionId?: string;
  database?: string;
}

export interface McpCallHistoryRequest {
  resource?: McpCallHistoryResource;
}

export function openMcpCallHistory(resource?: McpCallHistoryResource): void {
  window.dispatchEvent(new CustomEvent(MCP_CALL_HISTORY_OPEN_EVENT, { detail: resource }));
}

/**
 * The SQL an MCP call asked to run, read from the recorded request JSON.
 * Query tools carry a `sql` string; a list of strings is joined one statement per line.
 * Returns null when the request has no SQL (for example `list_tables`) or is not valid JSON.
 */
export function mcpRequestSql(requestJson?: string | null): string | null {
  if (!requestJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const sql = (parsed as { sql?: unknown }).sql;
  if (typeof sql === "string") return sql.trim() ? sql : null;
  if (Array.isArray(sql)) {
    const statements = sql.filter((item): item is string => typeof item === "string" && item.trim() !== "");
    return statements.length > 0 ? statements.join("\n") : null;
  }
  return null;
}
