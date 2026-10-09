/**
 * Read/write classification for Apache Solr REST requests.
 *
 * Mirrors `classify_solr_query_risk` in `crates/dbx-sql-core/src/query_execution_sql.rs`
 * so the desktop guards (read-only unlock, production safety) agree with the
 * backend read-only gate instead of treating every request as unrecognized.
 *
 * Solr write traffic funnels through `/{core}/update*` (plus `commit`) — for
 * every HTTP method, since Solr update handlers also answer GET commits.
 * CoreAdmin/Collections actions and ReplicationHandler commands ride on GET
 * too, so `action=`/`command=` values outside the read whitelists are
 * dangerous. Read-only POST handlers are the query
 * endpoints (select/query/get/export/...). Any other mutating method/path —
 * `/admin/*`, `/schema`, `/config`, core management — is classified dangerous.
 */

export type SolrRequestRisk = "read" | "write" | "dangerous";

const REQUEST_LINE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i;
const READ_ONLY_POST_ENDPOINTS = new Set(["select", "query", "get", "export", "terms", "suggest", "spell", "mlt", "sql", "graph", "clustering", "tvrh", "luke", "elevate", "browse", "debug"]);
const READ_ONLY_REPLICATION_COMMANDS = new Set(["details", "restorestatus", "filelist", "filecontent", "filedownload", "filemtime", "indexversion", "showversion"]);
const RISK_ORDER: Record<SolrRequestRisk, number> = { read: 0, write: 1, dangerous: 2 };

function parseRequestLine(line: string): { method: string; rawPath: string; endpoint: string; isUpdatePath: boolean; segments: string[] } | null {
  const match = line.trim().match(REQUEST_LINE);
  if (!match) return null;
  const rawPath = match[2];
  const path = (rawPath.split("?", 1)[0] ?? "").replace(/\/+$/, "");
  const segments = path.split("/").filter(Boolean);
  // Users may paste absolute Solr paths ("/solr/{core}/select") or relative
  // ones ("{core}/select"); drop the fixed /solr context segment if present.
  if (segments[0]?.toLowerCase() === "solr") segments.shift();
  // Update handler variants (/update/json, /update/json/docs, /update/csv)
  // nest below the update segment, so the last segment alone cannot spot them.
  const isUpdatePath = segments.some((segment) => segment.startsWith("update") || segment === "commit");
  return { method: match[1].toUpperCase(), rawPath, endpoint: segments[segments.length - 1]?.toLowerCase() ?? "", isUpdatePath, segments };
}

/**
 * CoreAdmin/Collections endpoints accept GET-triggered mutations
 * (`GET /admin/cores?action=CREATE&name=x` really creates a core). Only the
 * explicitly read-only actions stay "read"; any other action is dangerous.
 */
function solrAdminRequestIsMutation(rawPath: string, segments: string[]): boolean {
  const isAdminTarget = segments.some((segment, index) => segment.toLowerCase() === "admin" && ["cores", "collections"].includes(segments[index + 1]?.toLowerCase() ?? ""));
  if (!isAdminTarget) return false;
  const query = rawPath.split("?")[1];
  if (!query) return false;
  const action = query
    .split("&")
    .map((param) => param.split("=", 2))
    .find(([key]) => key.toLowerCase() === "action")?.[1];
  if (action === undefined) return false;
  return !["STATUS", "REQUESTSTATUS", "LIST"].includes(action.toUpperCase());
}

/**
 * The replication handler also takes GET-triggered mutations
 * (`GET /{core}/replication?command=disablereplication` really stops
 * replication). Only the explicitly read-only commands stay "read"; a missing
 * command falls back to the handler's default details response.
 */
function solrReplicationRequestIsMutation(rawPath: string, segments: string[]): boolean {
  if (segments[segments.length - 1]?.toLowerCase() !== "replication") return false;
  const query = rawPath.split("?")[1];
  if (!query) return false;
  const command = query
    .split("&")
    .map((param) => param.split("=", 2))
    .find(([key]) => key.toLowerCase() === "command")?.[1];
  if (command === undefined) return false;
  return !READ_ONLY_REPLICATION_COMMANDS.has(command.toLowerCase());
}

function classifyParsedRequest({ method, rawPath, endpoint, isUpdatePath, segments }: { method: string; rawPath: string; endpoint: string; isUpdatePath: boolean; segments: string[] }): SolrRequestRisk {
  // Solr update handlers also answer GET (commit/optimize/stream.body all
  // mutate), so update paths count as writes for every method, not just POST.
  if (isUpdatePath) return "write";
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return solrAdminRequestIsMutation(rawPath, segments) || solrReplicationRequestIsMutation(rawPath, segments) ? "dangerous" : "read";
  }
  if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
    return method === "POST" && READ_ONLY_POST_ENDPOINTS.has(endpoint) ? "read" : "dangerous";
  }
  return "dangerous";
}

/**
 * Classifies a single request: the request line is the first non-comment line,
 * everything after it is the JSON body. Returns null when the text is not a
 * REST request.
 */
export function classifySolrRequestRisk(request: string): SolrRequestRisk | null {
  const parsed = parseRequestLine(uncommentedLines(request)[0] ?? "");
  return parsed ? classifyParsedRequest(parsed) : null;
}

/**
 * Classifies every request in the editor text and returns the highest risk, so
 * a read request followed by a write is still guarded. Like the backend, the
 * text only counts as REST when its first non-comment line is a request line.
 */
export function classifySolrSourceRisk(source: string): SolrRequestRisk | null {
  const lines = uncommentedLines(source);
  if (!parseRequestLine(lines[0] ?? "")) return null;

  let highest: SolrRequestRisk = "read";
  for (const line of lines) {
    const parsed = parseRequestLine(line);
    if (!parsed) continue;
    const risk = classifyParsedRequest(parsed);
    if (RISK_ORDER[risk] > RISK_ORDER[highest]) highest = risk;
  }
  return highest;
}

/**
 * Whether a parsed request line targets a mutating path that is not a document
 * update — used by the dangerous-execution confirmation gate.
 */
export function isDangerousSolrRequest(method: string, path: string): boolean {
  const upperMethod = method.toUpperCase();
  const pathname = path.split("?", 1)[0].replace(/\/+$/, "");
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0]?.toLowerCase() === "solr") segments.shift();
  const endpoint = segments[segments.length - 1]?.toLowerCase() ?? "";
  const isUpdatePath = segments.some((segment) => segment.startsWith("update") || segment === "commit");
  // Document writes are guarded by the write confirmation, not the dangerous
  // gate — for every method, including GET-driven commits.
  if (isUpdatePath) return false;
  if (upperMethod === "GET" || upperMethod === "HEAD" || upperMethod === "OPTIONS") {
    return solrAdminRequestIsMutation(path, segments) || solrReplicationRequestIsMutation(path, segments);
  }
  if (upperMethod === "POST" || upperMethod === "PUT" || upperMethod === "PATCH" || upperMethod === "DELETE") {
    return !(upperMethod === "POST" && READ_ONLY_POST_ENDPOINTS.has(endpoint));
  }
  return true;
}

/**
 * Returns each line with its leading comments removed, dropping lines that hold
 * nothing else. Block comments spanning several lines are skipped as a whole so
 * a commented-out request line is never classified.
 */
function uncommentedLines(source: string): string[] {
  const lines: string[] = [];
  let inBlockComment = false;

  for (const rawLine of source.split("\n")) {
    let offset = 0;
    while (offset < rawLine.length) {
      if (inBlockComment) {
        const close = rawLine.indexOf("*/", offset);
        if (close < 0) break;
        inBlockComment = false;
        offset = close + 2;
        continue;
      }
      while (offset < rawLine.length && /\s/.test(rawLine[offset] ?? "")) offset += 1;
      if (offset >= rawLine.length) break;
      if (rawLine.startsWith("/*", offset)) {
        inBlockComment = true;
        offset += 2;
        continue;
      }
      if (rawLine[offset] === "#" || rawLine.startsWith("//", offset)) break;
      lines.push(rawLine.slice(offset));
      break;
    }
  }

  return lines;
}
