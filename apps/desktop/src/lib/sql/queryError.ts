export function isQueryTimeoutErrorMessage(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes("query timed out") || lower.includes("查询超时") || lower.includes("查詢逾時")) return true;
  // Agent RPC client-side timeout (tokio::time::timeout in agent_driver.rs). This is the
  // fallback when JDBC setQueryTimeout never fires (unsupported/unresponsive driver), so the
  // backend already treats it as a query timeout (is_agent_rpc_timeout_error in query.rs) —
  // surface the same action here to stay consistent with the backend.
  if (lower.startsWith("agent rpc call timed out")) return true;
  if (/\b(?:canceling|cancelling|canceled|cancelled)\b[\s\S]{0,80}\bstatement\b[\s\S]{0,80}\btimeout\b/.test(lower)) return true;
  if (/\b(?:connection|connect|pool|checkout|metadata|loading|health check|cancel request|ssh|tunnel)\b/.test(lower)) return false;
  return (
    /\b(?:query|statement|sql|execution|execute|executing)\b[\s\S]{0,80}\b(?:timed out|timeout expired|timeout exceeded|time-out)\b/.test(lower) ||
    /\b(?:timed out|timeout expired|timeout exceeded|time-out)\b[\s\S]{0,80}\b(?:query|statement|sql|execution|execute|executing)\b/.test(lower) ||
    /\bquery\b[\s\S]{0,80}\bexceeded\b[\s\S]{0,80}\b(?:execution\s+)?time\b/.test(lower)
  );
}
