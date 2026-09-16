/**
 * Read/write classification for Elasticsearch-compatible REST requests.
 *
 * Mirrors `classify_search_engine_query_risk` in
 * `crates/dbx-core/src/query_execution_sql.rs` so the desktop guards (read-only
 * unlock, production safety) agree with the backend read-only gate instead of
 * treating every `GET`/`POST` request as an unrecognized — and therefore
 * unsafe — statement.
 */

export type ElasticsearchRequestRisk = "read" | "write" | "dangerous";

const REQUEST_LINE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i;
const READ_ONLY_POST_ENDPOINTS = ["_search", "_count", "_sql", "_msearch", "_field_caps", "_terms_enum", "_validate", "_explain", "_rank_eval", "_search_shards"];
const WRITE_POST_ENDPOINTS = ["_doc", "_create", "_update", "_bulk"];
const RISK_ORDER: Record<ElasticsearchRequestRisk, number> = { read: 0, write: 1, dangerous: 2 };

interface ParsedRequestLine {
  method: string;
  segments: string[];
}

function parseRequestLine(line: string): ParsedRequestLine | null {
  const match = line.trim().match(REQUEST_LINE);
  if (!match) return null;
  const path = (match[2].split("?", 1)[0] ?? "").replace(/\/+$/, "");
  return { method: match[1].toUpperCase(), segments: path.split("/").filter(Boolean) };
}

function classifyParsedRequest({ method, segments }: ParsedRequestLine): ElasticsearchRequestRisk {
  const hasSegment = (candidate: string) => segments.some((segment) => segment.toLowerCase() === candidate);
  const hasDocumentId = (candidate: string) => {
    const index = segments.findIndex((segment) => segment.toLowerCase() === candidate);
    return index >= 0 && !!segments[index + 1];
  };

  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return "read";
  if (method === "POST") {
    if (READ_ONLY_POST_ENDPOINTS.some((endpoint) => hasSegment(endpoint))) return "read";
    return WRITE_POST_ENDPOINTS.some((endpoint) => hasSegment(endpoint)) ? "write" : "dangerous";
  }
  if (method === "PUT" && (hasDocumentId("_doc") || hasDocumentId("_create"))) return "write";
  if (method === "DELETE" && hasDocumentId("_doc")) return "write";
  return "dangerous";
}

/**
 * Classifies a single request: the request line is the first non-comment line,
 * everything after it is the JSON/NDJSON body. Returns null when the text is
 * not a REST request — Elasticsearch also accepts SQL, classified elsewhere.
 */
export function classifyElasticsearchRequestRisk(request: string): ElasticsearchRequestRisk | null {
  const parsed = parseRequestLine(uncommentedLines(request)[0] ?? "");
  return parsed ? classifyParsedRequest(parsed) : null;
}

/**
 * Classifies every request in the editor text and returns the highest risk, so
 * a read request followed by a write is still guarded. Like the backend, the
 * text only counts as REST when its first non-comment line is a request line;
 * anything else is left to the SQL classification.
 */
export function classifyElasticsearchSourceRisk(source: string): ElasticsearchRequestRisk | null {
  const lines = uncommentedLines(source);
  if (!parseRequestLine(lines[0] ?? "")) return null;

  let highest: ElasticsearchRequestRisk = "read";
  for (const line of lines) {
    const parsed = parseRequestLine(line);
    if (!parsed) continue;
    const risk = classifyParsedRequest(parsed);
    if (RISK_ORDER[risk] > RISK_ORDER[highest]) highest = risk;
  }
  return highest;
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
