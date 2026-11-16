/**
 * Read/write classification for CouchDB REST requests.
 * Mirrors `classify_couchdb_query_risk` in `crates/dbx-sql-core/src/query_execution_sql.rs`.
 */

export type CouchDbRequestRisk = "read" | "write" | "dangerous";

const REQUEST_LINE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i;
const READ_ONLY_POST_ENDPOINTS = new Set(["_find", "_explain", "_all_docs", "_bulk_get"]);

export function isDangerousCouchDbRequest(method: string, rawPath: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return false;
  if (m === "POST") {
    const path = (rawPath.split("?", 1)[0] ?? "").replace(/\/+$/, "");
    const segments = path.split("/").filter(Boolean);
    const last = segments[segments.length - 1]?.toLowerCase() ?? "";
    if (READ_ONLY_POST_ENDPOINTS.has(last)) return false;
    const isViewQuery = segments.some((s, i) => s === "_design" && segments[i + 2] === "_view");
    if (isViewQuery) return false;
  }
  return true;
}

export function classifyCouchDbRequestRisk(line: string): CouchDbRequestRisk | null {
  const match = line.trim().match(REQUEST_LINE);
  if (!match) return null;
  const method = match[1].toUpperCase();
  const rawPath = match[2];
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return "read";
  if (method === "POST") {
    return isDangerousCouchDbRequest(method, rawPath) ? "write" : "read";
  }
  return "dangerous";
}

export function classifyCouchDbSourceRisk(source: string): CouchDbRequestRisk | null {
  const lines = source.split("\n");
  let highest: CouchDbRequestRisk = "read";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
    const risk = classifyCouchDbRequestRisk(trimmed);
    if (!risk) continue;
    if (risk === "dangerous") return "dangerous";
    if (risk === "write") highest = "write";
  }
  return highest;
}
