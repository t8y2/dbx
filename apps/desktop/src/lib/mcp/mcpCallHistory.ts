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
