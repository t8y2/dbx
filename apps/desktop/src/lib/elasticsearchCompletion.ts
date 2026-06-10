export type ElasticsearchCompletionMode = "method" | "path" | "json";

export interface ElasticsearchCompletionItem {
  label: string;
  type: "keyword" | "property" | "text" | "snippet";
  detail?: string;
  info?: string;
  apply?: string;
  boost: number;
}

export interface ElasticsearchCompletionContext {
  mode: ElasticsearchCompletionMode;
  prefix: string;
  from: number;
  method?: string;
  path?: string;
  segmentIndex?: number;
}

export interface ElasticsearchCompletionInput {
  indices?: string[];
}

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE"] as const;

const ROOT_ENDPOINTS = [
  { label: "/_search", apply: "_search", method: "GET", detail: "Search all indices" },
  { label: "/_cat/indices", apply: "_cat/indices?v", method: "GET", detail: "List indices" },
  { label: "/_cluster/health", apply: "_cluster/health", method: "GET", detail: "Cluster health" },
  { label: "/_aliases", apply: "_aliases", method: "GET", detail: "List aliases" },
  { label: "/_bulk", apply: "_bulk\n", method: "POST", detail: "Bulk operations" },
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

  if (lineStart > 0 || safeCursor > firstLineLimit || looksLikeJsonBody(text, safeCursor)) {
    const jsonPrefix = readJsonPrefix(text, safeCursor);
    return { mode: "json", prefix: jsonPrefix.prefix, from: jsonPrefix.from };
  }

  const methodMatch = /^([A-Za-z]*)$/.exec(beforeCursorOnLine);
  if (methodMatch) {
    return {
      mode: "method",
      prefix: methodMatch[1] ?? "",
      from: lineStart,
    };
  }

  const commandMatch = /^([A-Za-z]+)\s+(\S*)/.exec(text.slice(lineStart, currentLineEnd));
  if (!commandMatch) {
    const prefix = readWordPrefix(text, safeCursor);
    return { mode: "method", prefix: prefix.prefix, from: prefix.from };
  }

  const method = commandMatch[1]?.toUpperCase();
  const path = commandMatch[2] ?? "";
  const pathStart = lineStart + (commandMatch[0].indexOf(path) >= 0 ? commandMatch[0].indexOf(path) : 0);
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

export function buildElasticsearchCompletionItems(text: string, cursor: number, input: ElasticsearchCompletionInput = {}): ElasticsearchCompletionItem[] {
  const context = getElasticsearchCompletionContext(text, cursor);
  return buildElasticsearchCompletionItemsFromContext(context, input);
}

export function buildElasticsearchCompletionItemsFromContext(context: ElasticsearchCompletionContext, input: ElasticsearchCompletionInput = {}): ElasticsearchCompletionItem[] {
  if (context.mode === "method") return methodItems(context.prefix);
  if (context.mode === "json") return jsonItems(context.prefix);
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

function jsonItems(prefix: string): ElasticsearchCompletionItem[] {
  const normalizedPrefix = prefix.replace(/^"/, "");
  const keyItems = JSON_KEYWORDS.filter((key) => matchesFuzzyPrefix(key, normalizedPrefix)).map((key) => ({
    label: `"${key}"`,
    type: "property" as const,
    detail: "Query DSL field",
    apply: `"${key}"`,
    boost: key.startsWith(normalizedPrefix) ? 95 : 70,
  }));
  const snippetItems = JSON_SNIPPETS.filter((snippet) => matchesFuzzyPrefix(snippet.label, normalizedPrefix)).map((snippet) => ({
    label: snippet.label,
    type: "snippet" as const,
    detail: snippet.detail,
    apply: snippet.apply,
    boost: 105,
  }));
  return dedupeAndSort([...snippetItems, ...keyItems]);
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
