export type ElasticsearchCompletionMode = "method" | "path" | "json";

export type ElasticsearchJsonSlot = "key" | "value";

export interface ElasticsearchCompletionItem {
  label: string;
  type: "keyword" | "property" | "text" | "snippet";
  detail?: string;
  info?: string;
  apply?: string;
  filterText?: string;
  // Set when `apply` carries snippet fields so the editor expands it instead of
  // inserting the raw `${}` markers.
  applyAsSnippet?: boolean;
  // The auto-closed quote sitting at the cursor, which the applied text replaces.
  replaceClosingQuote?: '"';
  boost: number;
}

export interface ElasticsearchCompletionContext {
  mode: ElasticsearchCompletionMode;
  prefix: string;
  from: number;
  method?: string;
  path?: string;
  segmentIndex?: number;
  replaceClosingQuote?: '"';
  jsonSlot?: ElasticsearchJsonSlot;
  hasKeySeparator?: boolean;
}

export interface ElasticsearchCompletionInput {
  indices?: string[];
}

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "HEAD"] as const;

const ROOT_ENDPOINTS = [
  { label: "/_search", apply: "_search", method: "GET", detail: "Search all indices" },
  { label: "/_cat/indices", apply: "_cat/indices?v", method: "GET", detail: "List indices" },
  { label: "/_cluster/health", apply: "_cluster/health", method: "GET", detail: "Cluster health" },
  { label: "/_cluster/stats", apply: "_cluster/stats?pretty", method: "GET", detail: "Cluster statistics" },
  { label: "/_nodes/stats", apply: "_nodes/stats?pretty", method: "GET", detail: "Node statistics" },
  { label: "/_cat/nodes", apply: "_cat/nodes?v", method: "GET", detail: "List nodes" },
  { label: "/_cat/shards", apply: "_cat/shards?v", method: "GET", detail: "List shards" },
  { label: "/_cat/thread_pool", apply: "_cat/thread_pool?v", method: "GET", detail: "Thread pools" },
  { label: "/_aliases", apply: "_aliases", method: "GET", detail: "List aliases" },
  { label: "/_bulk", apply: "_bulk\n", method: "POST", detail: "Bulk operations" },
  { label: "/_msearch", apply: "_msearch\n", method: "POST", detail: "Multi search" },
  { label: "/_tasks", apply: "_tasks?detailed=true", method: "GET", detail: "List tasks" },
  { label: "/_count", apply: "_count", method: "GET", detail: "Count documents" },
];

const INDEX_ENDPOINTS = [
  {
    label: "_search",
    apply: '_search\n{\n  "query": {\n    "match_all": {}\n  }\n}',
    method: "GET",
    detail: "Search this index",
  },
  { label: "_mapping", apply: "_mapping", method: "GET", detail: "Show mapping" },
  { label: "_settings", apply: "_settings", method: "GET", detail: "Show settings" },
  { label: "_count", apply: "_count", method: "GET", detail: "Count documents" },
  {
    label: "_doc",
    apply: '_doc/${}\n{\n  "${}": "${}"\n}',
    method: "POST",
    detail: "Create document",
  },
  { label: "_refresh", apply: "_refresh", method: "POST", detail: "Refresh index" },
];

const JSON_KEYWORDS = ["query", "bool", "must", "should", "must_not", "filter", "match", "match_all", "term", "terms", "range", "exists", "sort", "aggs", "aggregations", "size", "from", "_source", "fields", "track_total_hits"];

const JSON_ARRAY_KEYS = new Set(["must", "should", "must_not", "filter", "sort", "_source", "fields"]);
const JSON_SCALAR_KEYS = new Set(["size", "from", "track_total_hits"]);

// Value scaffold inserted after a completed key so the matching brackets come
// along with it, with the cursor parked where the value goes.
function jsonKeyValueTemplate(key: string): string {
  if (JSON_SCALAR_KEYS.has(key)) return "${}";
  return JSON_ARRAY_KEYS.has(key) ? "[${}]" : "{${}}";
}

const JSON_SNIPPETS = [
  {
    label: "match_all",
    apply: '"match_all": {}',
    detail: "Match all documents",
  },
  {
    label: "bool",
    apply: '"bool": {\n  "must": [\n    {}\n  ],\n  "filter": []\n}',
    detail: "Bool query",
  },
  {
    label: "range",
    apply: '"range": {\n  "${field}": {\n    "gte": "${value}"\n  }\n}',
    detail: "Range query",
  },
  {
    label: "terms",
    apply: '"terms": {\n  "${field}": []\n}',
    detail: "Terms query",
  },
];

export function getElasticsearchCompletionContext(text: string, cursor: number): ElasticsearchCompletionContext {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const lineStart = text.lastIndexOf("\n", safeCursor - 1) + 1;
  const lineEnd = text.indexOf("\n", lineStart);
  const currentLineEnd = lineEnd >= 0 ? lineEnd : text.length;
  const beforeCursorOnLine = text.slice(lineStart, safeCursor);
  const firstLineEnd = text.indexOf("\n");
  const firstLineLimit = firstLineEnd >= 0 ? firstLineEnd : text.length;

  // Check the current line before falling back to JSON mode so completion also
  // works after leading comments and on subsequent REST requests.
  const methodMatch = /^\s*([A-Za-z]*)$/.exec(beforeCursorOnLine);
  if (methodMatch) {
    const leadingWhitespace = beforeCursorOnLine.length - beforeCursorOnLine.trimStart().length;
    return {
      mode: "method",
      prefix: methodMatch[1] ?? "",
      from: lineStart + leadingWhitespace,
    };
  }

  const commandMatch = /^\s*([A-Za-z]+)\s+(\S*)/.exec(text.slice(lineStart, currentLineEnd));
  if (commandMatch) {
    const method = commandMatch[1]?.toUpperCase();
    const path = commandMatch[2] ?? "";
    const pathStart = lineStart + commandMatch[0].length - path.length;
    const pathCursor = Math.max(0, safeCursor - pathStart);
    const boundedPathCursor = Math.min(pathCursor, path.length);
    const beforePathCursor = path.slice(0, boundedPathCursor);
    const segmentStartInPath = beforePathCursor.lastIndexOf("/") + 1;
    const prefix = beforePathCursor.slice(segmentStartInPath);
    const segmentIndex = beforePathCursor.slice(0, segmentStartInPath).split("/").filter(Boolean).length;

    return {
      mode: "path",
      prefix,
      from: pathStart + segmentStartInPath,
      method,
      path,
      segmentIndex,
    };
  }

  if (lineStart > 0 || safeCursor > firstLineLimit || looksLikeJsonBody(text, safeCursor)) {
    const jsonPrefix = readJsonPrefix(text, safeCursor);
    const replaceClosingQuote = jsonPrefix.prefix.startsWith('"') && text[safeCursor] === '"' ? ('"' as const) : undefined;
    return {
      mode: "json",
      prefix: jsonPrefix.prefix,
      from: jsonPrefix.from,
      replaceClosingQuote,
      jsonSlot: readJsonSlot(text, jsonPrefix.from),
      hasKeySeparator: hasJsonKeySeparator(text, safeCursor),
    };
  }

  const prefix = readWordPrefix(text, safeCursor);
  return { mode: "method", prefix: prefix.prefix, from: prefix.from };
}

export function buildElasticsearchCompletionItems(text: string, cursor: number, input: ElasticsearchCompletionInput = {}): ElasticsearchCompletionItem[] {
  const context = getElasticsearchCompletionContext(text, cursor);
  return buildElasticsearchCompletionItemsFromContext(context, input);
}

export function buildElasticsearchCompletionItemsFromContext(context: ElasticsearchCompletionContext, input: ElasticsearchCompletionInput = {}): ElasticsearchCompletionItem[] {
  if (context.mode === "method") return methodItems(context.prefix);
  if (context.mode === "json") return jsonItems(context);
  return pathItems(context, input.indices ?? []);
}

export function shouldAutoOpenElasticsearchCompletion(text: string, cursor: number): boolean {
  const previousChar = text[cursor - 1];
  if (!previousChar) return false;
  if (/[{,}\]\n\r]/.test(previousChar)) return false;
  if (/[\w/_."]/.test(previousChar)) return true;
  return false;
}

export function getElasticsearchCompletionResultValidFor(): RegExp {
  return /[\w/_."]*$/;
}

function methodItems(prefix: string): ElasticsearchCompletionItem[] {
  return HTTP_METHODS.filter((method) => matchesPrefix(method, prefix)).map((method) => ({
    label: method,
    type: "keyword",
    detail: "HTTP method",
    apply: `${method} /`,
    boost: 120,
  }));
}

function pathItems(context: ElasticsearchCompletionContext, indices: string[]): ElasticsearchCompletionItem[] {
  const items: ElasticsearchCompletionItem[] = [];
  const path = context.path ?? "";
  const segments = path.split("/").filter(Boolean);
  const isFirstSegment = context.segmentIndex === 0;
  const isRootApiSegment = isFirstSegment && context.prefix.startsWith("_");

  if (isFirstSegment && !isRootApiSegment) {
    items.push(...indexItems(context.prefix, indices));
  }

  if (isFirstSegment || isRootApiSegment) {
    items.push(...rootEndpointItems(context.prefix));
  }

  if (segments.length >= 1 && !segments[0]?.startsWith("_")) {
    items.push(...indexEndpointItems(context.prefix));
  }

  return dedupeAndSort(items);
}

function indexItems(prefix: string, indices: string[]): ElasticsearchCompletionItem[] {
  return indices
    .filter((index) => matchesFuzzyPrefix(index, prefix))
    .slice(0, 100)
    .map((index) => ({
      label: index,
      type: "text" as const,
      detail: "index",
      apply: index,
      boost: index.toLowerCase().startsWith(prefix.toLowerCase()) ? 110 : 80,
    }));
}

function rootEndpointItems(prefix: string): ElasticsearchCompletionItem[] {
  const normalizedPrefix = prefix.startsWith("/") ? prefix.slice(1) : prefix;
  return ROOT_ENDPOINTS.filter((endpoint) => matchesFuzzyPrefix(endpoint.label.slice(1), normalizedPrefix)).map((endpoint) => ({
    label: endpoint.label,
    type: endpoint.apply.includes("\n") ? ("snippet" as const) : ("property" as const),
    detail: `${endpoint.method} ${endpoint.detail}`,
    apply: endpoint.apply,
    boost: 95,
  }));
}

function indexEndpointItems(prefix: string): ElasticsearchCompletionItem[] {
  return INDEX_ENDPOINTS.filter((endpoint) => matchesFuzzyPrefix(endpoint.label, prefix)).map((endpoint) => ({
    label: endpoint.label,
    type: endpoint.apply.includes("\n") ? ("snippet" as const) : ("property" as const),
    detail: `${endpoint.method} ${endpoint.detail}`,
    apply: endpoint.apply,
    boost: 100,
  }));
}

function jsonItems(context: ElasticsearchCompletionContext): ElasticsearchCompletionItem[] {
  const quoted = context.prefix.startsWith('"');
  const normalizedPrefix = context.prefix.replace(/^"/, "");
  // Only an object key without its own `:` yet may pull the value scaffold in;
  // anywhere else the extra `": {}"` would produce invalid JSON.
  const withValueTemplate = context.jsonSlot === "key" && !context.hasKeySeparator;
  const keyItems = JSON_KEYWORDS.filter((key) => matchesFuzzyPrefix(key, normalizedPrefix)).map((key) => ({
    label: `"${key}"`,
    type: "property" as const,
    detail: "Query DSL field",
    apply: withValueTemplate ? `"${key}": ${jsonKeyValueTemplate(key)}` : `"${key}"`,
    applyAsSnippet: withValueTemplate,
    replaceClosingQuote: context.replaceClosingQuote,
    boost: key.startsWith(normalizedPrefix) ? 95 : 70,
  }));
  // Snippets already spell out `"key": value`, so they only fit a key slot.
  const snippetItems = withValueTemplate
    ? JSON_SNIPPETS.filter((snippet) => matchesFuzzyPrefix(snippet.label, normalizedPrefix)).map((snippet) => ({
        label: snippet.label,
        type: "snippet" as const,
        detail: snippet.detail,
        apply: snippet.apply,
        // Bare snippet labels cannot match a typed opening quote, so let the
        // editor filter them on the quoted form it sees in the document.
        filterText: quoted ? `"${snippet.label}"` : undefined,
        replaceClosingQuote: context.replaceClosingQuote,
        boost: 105,
      }))
    : [];
  return dedupeAndSort([...snippetItems, ...keyItems]);
}

// Reads the body of the request the cursor sits in, with strings and comments
// blanked out so their quotes and braces cannot be mistaken for structure.
function readRequestBody(text: string, from: number): string {
  const before = text.slice(0, from);
  const requestLine = /[\s\S]*(?:^|\n)[ \t]*(?:GET|POST|PUT|DELETE|HEAD)[ \t][^\n]*/i.exec(before);
  return before.slice(requestLine?.[0].length ?? 0).replace(/"(?:\\.|[^"\\])*"|(?:#|\/\/)[^\n]*/g, "");
}

// Tracks open brackets so an array element or a value after `:` is never
// mistaken for an object key.
function readJsonSlot(text: string, from: number): ElasticsearchJsonSlot {
  const stack: string[] = [];
  let last = "";
  for (const char of readRequestBody(text, from)) {
    if (/\s/.test(char)) continue;
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") stack.pop();
    last = char;
  }
  return stack[stack.length - 1] === "{" && (last === "{" || last === ",") ? "key" : "value";
}

function hasJsonKeySeparator(text: string, cursor: number): boolean {
  let index = cursor;
  // The caret may sit inside the key, so step over the rest of the token and
  // its closing quote before looking for the separator.
  while (index < text.length && /[\w_]/.test(text[index] ?? "")) index++;
  if (text[index] === '"') index++;
  while (text[index] === " " || text[index] === "\t") index++;
  return text[index] === ":";
}

function looksLikeJsonBody(text: string, cursor: number): boolean {
  const before = text.slice(0, cursor);
  return before.includes("\n") || before.lastIndexOf("{") > before.lastIndexOf("\n");
}

function readJsonPrefix(text: string, cursor: number): { prefix: string; from: number } {
  let from = cursor;
  while (from > 0 && /[\w_"]/.test(text[from - 1] ?? "")) from--;
  return { prefix: text.slice(from, cursor), from };
}

function readWordPrefix(text: string, cursor: number): { prefix: string; from: number } {
  let from = cursor;
  while (from > 0 && /[A-Za-z]/.test(text[from - 1] ?? "")) from--;
  return { prefix: text.slice(from, cursor), from };
}

function matchesPrefix(value: string, prefix: string): boolean {
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

function matchesFuzzyPrefix(value: string, prefix: string): boolean {
  const normalizedValue = value.toLowerCase();
  const normalizedPrefix = prefix.toLowerCase();
  return !normalizedPrefix || normalizedValue.includes(normalizedPrefix);
}

function dedupeAndSort(items: ElasticsearchCompletionItem[]): ElasticsearchCompletionItem[] {
  const seen = new Set<string>();
  const deduped: ElasticsearchCompletionItem[] = [];
  for (const item of items) {
    const key = `${item.type}:${item.label}:${item.apply ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped.sort((a, b) => b.boost - a.boost);
}
