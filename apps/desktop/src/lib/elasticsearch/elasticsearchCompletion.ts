export type ElasticsearchCompletionMode = "method" | "path" | "json";

export type ElasticsearchJsonSlot = "key" | "value";

export interface ElasticsearchCompletionItem {
  label: string;
  type: "keyword" | "property" | "text" | "snippet" | "column";
  detail?: string;
  info?: string;
  apply?: string;
  filterText?: string;
  sortText?: string;
  // Set when `apply` carries snippet fields so the editor expands it instead of
  // inserting the raw `${}` markers.
  applyAsSnippet?: boolean;
  // The auto-closed quote sitting at the cursor, which the applied text replaces.
  replaceClosingQuote?: '"';
  boost: number;
}

export interface ElasticsearchCompletionField {
  name: string;
  dataType?: string;
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
  jsonFieldSlot?: boolean;
  hasKeySeparator?: boolean;
  jsonIndent?: string;
  index?: string;
}

export interface ElasticsearchCompletionInput {
  indices?: string[];
  fields?: ElasticsearchCompletionField[];
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

// Query-clause objects whose keys are mapping field names (`"term": { "status": ... }`).
const FIELD_NAME_OBJECT_KEYS = new Set(["term", "terms", "match", "match_phrase", "match_phrase_prefix", "match_bool_prefix", "range", "wildcard", "prefix", "fuzzy", "regexp", "span_term"]);

// `terms`/`range` are also aggregation types whose keys are `field`/`ranges`, not mapping names.
const AGGREGATION_TYPE_FIELD_OBJECT_KEYS = new Set(["terms", "range"]);
const AGGREGATION_KEYS = new Set(["aggs", "aggregations"]);
const QUERY_CLAUSE_KEYS = new Set(["query", "bool", "must", "should", "filter", "must_not", "nested", "constant_score"]);

// Arrays whose values (or object-element keys) are mapping field names.
const FIELD_NAME_ARRAY_KEYS = new Set(["sort", "_source", "fields"]);

// Object keys whose JSON value is a mapping field name (`"exists": { "field": "status" }`).
const FIELD_VALUE_KEYS = new Set(["field", "path"]);

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
    label: "match",
    apply: '"match": {\n  "${field}": "${value}"\n}',
    detail: "Match query",
  },
  {
    label: "term",
    apply: '"term": {\n  "${field}": "${value}"\n}',
    detail: "Term query",
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
    label: "exists",
    apply: '"exists": {\n  "field": "${field}"\n}',
    detail: "Exists query",
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
  // A bare word on a JSON body line is a DSL key, not another HTTP method.
  // Without this guard, typing `term` after an opening `{` incorrectly enters
  // method mode and produces no JSON suggestions until a quote is added.
  if (methodMatch && (lineStart === 0 || !hasOpenJsonContainer(text, safeCursor))) {
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
    const inspection = inspectJsonBody(text, jsonPrefix.from);
    return {
      mode: "json",
      prefix: jsonPrefix.prefix,
      from: jsonPrefix.from,
      replaceClosingQuote,
      jsonSlot: inspection.slot,
      jsonFieldSlot: isJsonFieldNameSlot(inspection),
      hasKeySeparator: hasJsonKeySeparator(text, safeCursor),
      jsonIndent: beforeCursorOnLine.match(/^\s*/)?.[0] ?? "",
      index: elasticsearchRequestIndex(text, safeCursor),
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
  if (context.mode === "json") return jsonItems(context, input.fields ?? []);
  return pathItems(context, input.indices ?? []);
}

export function elasticsearchCompletionNeedsFields(context: ElasticsearchCompletionContext): boolean {
  return context.mode === "json" && context.jsonFieldSlot === true;
}

const MAX_MAPPING_FIELDS = 500;

/** Flatten `GET /{index}/_mapping` into completion fields. Iterative on purpose: a recursive walk is the wrong model for this JSON. */
export function flattenElasticsearchMappingFields(mapping: unknown): ElasticsearchCompletionField[] {
  const properties = elasticsearchMappingProperties(mapping);
  if (!properties) return [];

  const fields: ElasticsearchCompletionField[] = [];
  const seenNames = new Set<string>();
  const seenObjects = new Set<Record<string, unknown>>();
  const stack: Array<{ prefix: string; properties: Record<string, unknown> }> = [{ prefix: "", properties }];

  while (stack.length > 0 && fields.length < MAX_MAPPING_FIELDS) {
    const current = stack.pop();
    if (!current || seenObjects.has(current.properties)) continue;
    seenObjects.add(current.properties);
    for (const [name, definition] of Object.entries(current.properties)) {
      if (fields.length >= MAX_MAPPING_FIELDS) break;
      if (!isJsonObject(definition)) continue;
      const fieldName = current.prefix ? `${current.prefix}.${name}` : name;
      const fieldType = typeof definition.type === "string" ? definition.type : isJsonObject(definition.properties) ? "object" : undefined;
      if (fieldType && !seenNames.has(fieldName)) {
        seenNames.add(fieldName);
        fields.push({ name: fieldName, dataType: fieldType });
      }
      // Only mapping subtrees: `properties` (object/nested) and `fields` (multi-fields).
      // Never walk `index_options`, `path`, analyzer settings, etc.
      if (isJsonObject(definition.properties)) stack.push({ prefix: fieldName, properties: definition.properties });
      if (isJsonObject(definition.fields)) stack.push({ prefix: fieldName, properties: definition.fields });
    }
  }
  return fields;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function elasticsearchMappingProperties(mapping: unknown): Record<string, unknown> | undefined {
  if (!isJsonObject(mapping)) return undefined;
  const collected: Record<string, unknown> = {};
  const consider = (node: unknown) => {
    if (!isJsonObject(node)) return;
    const mappings = isJsonObject(node.mappings) ? node.mappings : node;
    if (isJsonObject(mappings.properties)) {
      Object.assign(collected, mappings.properties);
      return;
    }
    for (const typed of Object.values(mappings)) {
      if (isJsonObject(typed) && isJsonObject(typed.properties)) Object.assign(collected, typed.properties);
    }
  };
  if (isJsonObject(mapping.mappings)) consider(mapping);
  else for (const value of Object.values(mapping)) consider(value);
  return Object.keys(collected).length > 0 ? collected : undefined;
}

export function shouldAutoOpenElasticsearchCompletion(text: string, cursor: number): boolean {
  const previousChar = text[cursor - 1];
  if (!previousChar) return false;
  if (/[{,}\]\n\r]/.test(previousChar)) return false;
  if (/[\w/_.".-]/.test(previousChar)) return true;
  return false;
}

export function getElasticsearchCompletionResultValidFor(): RegExp {
  return /[\w/_."-]*$/;
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
    .filter((index) => matchesIndexFuzzyPrefix(index, prefix))
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

function jsonItems(context: ElasticsearchCompletionContext, fields: ElasticsearchCompletionField[]): ElasticsearchCompletionItem[] {
  if (context.jsonFieldSlot) return fieldItems(context, fields);
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
        apply: indentJsonSnippet(snippet.apply, context.jsonIndent ?? ""),
        // Bare snippet labels cannot match a typed opening quote, so let the
        // editor filter them on the quoted form it sees in the document.
        filterText: quoted ? `"${snippet.label}"` : undefined,
        replaceClosingQuote: context.replaceClosingQuote,
        boost: 105,
      }))
    : [];
  return dedupeAndSort([...snippetItems, ...keyItems]);
}

function fieldItems(context: ElasticsearchCompletionContext, fields: ElasticsearchCompletionField[]): ElasticsearchCompletionItem[] {
  const quoted = context.prefix.startsWith('"');
  const normalizedPrefix = context.prefix.replace(/^"/, "");
  return fields
    .filter((field) => matchesElasticsearchFieldPrefix(field.name, normalizedPrefix))
    .map((field) => {
      const depth = field.name.split(".").length;
      return {
        label: `"${field.name}"`,
        type: "column" as const,
        detail: field.dataType || "field",
        apply: `"${field.name}"`,
        // Quoted labels cannot prefix-match an unquoted typed token (`ci` vs `"city"`),
        // so expose the bare field name as filterText for CodeMirror's matcher.
        filterText: quoted ? `"${field.name}"` : field.name,
        replaceClosingQuote: context.replaceClosingQuote,
        // Shallower paths first. Default editor sort uses localeCompare on labels,
        // which puts `"nested_comments"` *after* its children; sortText avoids that.
        sortText: `${String(depth).padStart(2, "0")}\t${field.name}`,
        boost: 200 - depth * 20,
      };
    })
    .sort((left, right) => right.boost - left.boost || (left.sortText ?? left.label).localeCompare(right.sortText ?? right.label))
    .slice(0, 100);
}

function indentJsonSnippet(snippet: string, baseIndent: string): string {
  if (!baseIndent) return snippet;
  return snippet.replace(/\n/g, `\n${baseIndent}`);
}

// Reads the body of the request the cursor sits in, with strings and comments
// blanked out so their quotes and braces cannot be mistaken for structure.
function readRequestBody(text: string, from: number): string {
  const before = text.slice(0, from);
  const requestLine = /[\s\S]*(?:^|\n)[ \t]*(?:GET|POST|PUT|DELETE|HEAD)[ \t][^\n]*/i.exec(before);
  return before.slice(requestLine?.[0].length ?? 0).replace(/"(?:\\.|[^"\\])*"|(?:#|\/\/)[^\n]*/g, "");
}

function hasOpenJsonContainer(text: string, cursor: number): boolean {
  const stack: string[] = [];
  for (const char of readRequestBody(text, cursor)) {
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") stack.pop();
  }
  return stack.length > 0;
}

interface JsonFrame {
  kind: "{" | "[";
  key: string | null;
}

interface JsonInspection {
  slot: ElasticsearchJsonSlot;
  parentKey: string | null;
  parentKind: "{" | "[" | null;
  nearestNamedKey: string | null;
  currentKey: string | null;
  ancestorKeys: string[];
}

// Walks the current REST request body while keeping object keys, so a field
// name inside `"term": { | }` is not treated the same as a DSL key inside `"bool"`.
function inspectJsonBody(text: string, from: number): JsonInspection {
  const before = text.slice(0, from);
  const requestLine = /[\s\S]*(?:^|\n)[ \t]*(?:GET|POST|PUT|DELETE|HEAD)[ \t][^\n]*/i.exec(before);
  const bodyStart = requestLine?.[0].length ?? 0;
  const stack: JsonFrame[] = [];
  let pendingKey: string | null = null;
  let last = "";
  let index = bodyStart;

  while (index < from) {
    const char = before[index] ?? "";
    if (char === "#" || (char === "/" && before[index + 1] === "/")) {
      const newline = before.indexOf("\n", index);
      index = newline < 0 ? from : newline;
      continue;
    }

    if (char === '"') {
      const string = readJsonString(before, index, from);
      if (string.end < 0) break;
      index = string.end;
      let lookahead = index;
      while (lookahead < from && (before[lookahead] === " " || before[lookahead] === "\t")) lookahead++;
      if (before[lookahead] === ":") {
        pendingKey = string.value;
        continue;
      }
      last = '"';
      continue;
    }

    if (/\s/.test(char)) {
      index++;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push({ kind: char, key: pendingKey });
      pendingKey = null;
      last = char;
      index++;
      continue;
    }

    if (char === "}" || char === "]") {
      stack.pop();
      pendingKey = null;
      last = char;
      index++;
      continue;
    }

    if (char === ",") {
      pendingKey = null;
      last = char;
      index++;
      continue;
    }

    last = char;
    index++;
  }

  const top = stack[stack.length - 1];
  const slot: ElasticsearchJsonSlot = top?.kind === "{" && (last === "{" || last === ",") ? "key" : "value";
  let nearestNamedKey: string | null = null;
  for (let depth = stack.length - 1; depth >= 0; depth--) {
    const key = stack[depth]?.key;
    if (key) {
      nearestNamedKey = key;
      break;
    }
  }

  return {
    slot,
    parentKey: top?.key ?? null,
    parentKind: top?.kind ?? null,
    nearestNamedKey,
    currentKey: slot === "value" ? pendingKey : null,
    ancestorKeys: stack.map((frame) => frame.key).filter((key): key is string => !!key),
  };
}

function readJsonString(text: string, start: number, limit: number): { end: number; value: string } {
  let index = start + 1;
  let escaped = false;
  let value = "";
  while (index < limit) {
    const char = text[index] ?? "";
    if (escaped) {
      value += char;
      escaped = false;
      index++;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      index++;
      continue;
    }
    if (char === '"') return { end: index + 1, value };
    value += char;
    index++;
  }
  return { end: -1, value };
}

function isJsonFieldNameSlot(inspection: JsonInspection): boolean {
  if (inspection.slot === "key") {
    if (inspection.parentKey && FIELD_NAME_OBJECT_KEYS.has(inspection.parentKey)) {
      return !isAggregationTypeClause(inspection);
    }
    // Object-form sort (`"sort": { "createdAt": "desc" }`) uses field names as keys.
    // Array-form sort objects (`"sort": [{ "createdAt": ... }]`) have no key of their
    // own; `_source`/`fields` objects do not (`includes`/`field`/`format`).
    if (inspection.parentKey === "sort") return true;
    return inspection.parentKind === "{" && !inspection.parentKey && inspection.nearestNamedKey === "sort";
  }
  if (inspection.currentKey && FIELD_VALUE_KEYS.has(inspection.currentKey)) return true;
  return inspection.parentKind === "[" && !!inspection.parentKey && FIELD_NAME_ARRAY_KEYS.has(inspection.parentKey);
}

function isAggregationTypeClause(inspection: JsonInspection): boolean {
  if (!inspection.parentKey || !AGGREGATION_TYPE_FIELD_OBJECT_KEYS.has(inspection.parentKey)) return false;
  if (!inspection.ancestorKeys.some((key) => AGGREGATION_KEYS.has(key))) return false;
  return !inspection.ancestorKeys.some((key) => QUERY_CLAUSE_KEYS.has(key));
}

function elasticsearchRequestIndex(text: string, cursor: number): string | undefined {
  const match = /[\s\S]*(?:^|\n)[ \t]*(?:GET|POST|PUT|DELETE|HEAD)[ \t]+(\S+)/i.exec(text.slice(0, cursor));
  const path = match?.[1];
  if (!path) return undefined;
  const first = (path.split("?")[0] ?? "").split("/").filter(Boolean)[0];
  if (!first || first.startsWith("_")) return undefined;
  try {
    return decodeURIComponent(first);
  } catch {
    return first;
  }
}

function hasJsonKeySeparator(text: string, cursor: number): boolean {
  let index = cursor;
  // The caret may sit inside the key, so step over the rest of the token and
  // its closing quote before looking for the separator.
  while (index < text.length && /[\w_.-]/.test(text[index] ?? "")) index++;
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
  while (from > 0 && /[\w_.\-"]/.test(text[from - 1] ?? "")) from--;
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

function matchesIndexFuzzyPrefix(value: string, prefix: string): boolean {
  const normalizedValue = value.toLowerCase();
  const normalizedPrefix = prefix.toLowerCase();
  let from = 0;
  for (const char of normalizedPrefix) {
    const position = normalizedValue.indexOf(char, from);
    if (position < 0) return false;
    from = position + char.length;
  }
  return true;
}

function matchesFuzzyPrefix(value: string, prefix: string): boolean {
  const normalizedValue = value.toLowerCase();
  const normalizedPrefix = prefix.toLowerCase();
  return !normalizedPrefix || normalizedValue.includes(normalizedPrefix);
}

// Kibana Console: flatten mapping to dotted paths, then prefix-filter the full name.
// `"ne"` matches `nested_comments` and `nested_comments.user`; `"nested_comments."` keeps only children.
// Do not use substring match (`rf_hotness` must not appear for `"ne"`).
function matchesElasticsearchFieldPrefix(fieldName: string, prefix: string): boolean {
  const name = fieldName.toLowerCase();
  const typed = prefix.toLowerCase();
  return !typed || name.startsWith(typed);
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
