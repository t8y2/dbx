import type { ComposerTranslation } from "vue-i18n";
import { normalizeJsonArgument } from "@dbx-app/mongo-shell";
import type { DatabaseType } from "@/types/database";
import { quoteUnquotedObjectKeys } from "@/lib/mongo/mongoShellCommand";
import { formatMongoShellLiteral } from "@/lib/mongo/mongoDocumentValues";

export type DocumentStoreKind = "mongodb" | "elasticsearch";
export type DocumentFilterMode = "equals" | "not-equals" | "like" | "not-like" | "greater-than" | "less-than" | "is-null" | "is-not-null";
export type ElasticsearchBoolClause = "filter" | "must" | "should" | "must_not";
export type ElasticsearchQueryType = "term" | "terms" | "match" | "match_phrase" | "wildcard" | "range_gt" | "range_gte" | "range_lt" | "range_lte" | "exists";

export type DocumentFilterRule = {
  id: string;
  fieldName: string;
  mode: DocumentFilterMode;
  rawValue: string;
  conjunction: "AND" | "OR";
  elasticsearchClause?: ElasticsearchBoolClause;
  elasticsearchQueryType?: ElasticsearchQueryType;
};

export type DocumentFieldPathKind = "scalar" | "object" | "array" | "array-object" | "mixed";

export type DocumentFieldPathNode = {
  key: string;
  path: string;
  label: string;
  displayPath: string;
  kind: DocumentFieldPathKind;
  selectable: boolean;
  sampleValue?: unknown;
  children: DocumentFieldPathNode[];
};

export type DocumentStoreQueryPreviewOptions = {
  collection: string;
  filterJson?: string;
  sortJson?: string;
  skip: number;
  limit: number;
};

export type DocumentStoreProvider = {
  kind: DocumentStoreKind;
  filterInputLabel: string;
  sortInputLabel: string;
  documentsLabel(options: { total: number; t: ComposerTranslation }): string;
  queryPreview(options: DocumentStoreQueryPreviewOptions): string;
  sortInputForColumn(column: string, direction: "asc" | "desc" | null): string;
};

export const documentFilterModeOptions: Array<{ value: DocumentFilterMode; labelKey: string }> = [
  { value: "equals", labelKey: "grid.filterBuilderEquals" },
  { value: "not-equals", labelKey: "grid.filterBuilderNotEquals" },
  { value: "like", labelKey: "grid.filterBuilderContains" },
  { value: "not-like", labelKey: "grid.filterBuilderNotContains" },
  { value: "greater-than", labelKey: "grid.filterBuilderGreaterThan" },
  { value: "less-than", labelKey: "grid.filterBuilderLessThan" },
  { value: "is-null", labelKey: "grid.filterBuilderIsNull" },
  { value: "is-not-null", labelKey: "grid.filterBuilderIsNotNull" },
];

export const elasticsearchBoolClauseOptions: ElasticsearchBoolClause[] = ["filter", "must", "should", "must_not"];

const ELASTICSEARCH_TEXT_QUERY_TYPES: ElasticsearchQueryType[] = ["match", "match_phrase", "term", "wildcard", "exists"];
const ELASTICSEARCH_KEYWORD_QUERY_TYPES: ElasticsearchQueryType[] = ["term", "terms", "wildcard", "exists"];
const ELASTICSEARCH_RANGE_QUERY_TYPES: ElasticsearchQueryType[] = ["term", "terms", "range_gt", "range_gte", "range_lt", "range_lte", "exists"];
const ELASTICSEARCH_BOOLEAN_QUERY_TYPES: ElasticsearchQueryType[] = ["term", "exists"];

export function elasticsearchQueryTypeOptions(fieldType?: string): ElasticsearchQueryType[] {
  const normalized = fieldType?.trim().toLowerCase() ?? "";
  if (normalized === "text" || normalized === "search_as_you_type") return ELASTICSEARCH_TEXT_QUERY_TYPES;
  if (normalized === "keyword" || normalized === "constant_keyword" || normalized === "wildcard") return ELASTICSEARCH_KEYWORD_QUERY_TYPES;
  if (/^(?:byte|short|integer|long|unsigned_long|half_float|float|double|scaled_float|date|date_nanos|ip)$/.test(normalized)) return ELASTICSEARCH_RANGE_QUERY_TYPES;
  if (normalized === "boolean") return ELASTICSEARCH_BOOLEAN_QUERY_TYPES;
  return ["term", "terms", "match", "match_phrase", "wildcard", "range_gt", "range_gte", "range_lt", "range_lte", "exists"];
}

const mongoDocumentProvider: DocumentStoreProvider = {
  kind: "mongodb",
  filterInputLabel: "find",
  sortInputLabel: "sort",
  documentsLabel: ({ total, t }) => t("mongo.documents", { count: total }),
  queryPreview: ({ collection, filterJson, sortJson, skip, limit }) => {
    const collectionRef = `db.getCollection(${JSON.stringify(collection)})`;
    const parts = [`${collectionRef}.find(${mongoShellPreviewLiteral(filterJson || "{}")})`];
    if (sortJson?.trim()) parts.push(`.sort(${mongoShellPreviewLiteral(sortJson)})`);
    parts.push(`.skip(${skip}).limit(${limit})`);
    return parts.join("");
  },
  sortInputForColumn: (column, direction) => (direction ? JSON.stringify({ [column]: direction === "asc" ? 1 : -1 }) : ""),
};

function mongoShellPreviewLiteral(json: string): string {
  const trimmed = json.trim();
  if (!trimmed) return "{}";
  try {
    return formatMongoShellLiteral(JSON.parse(trimmed));
  } catch {
    return trimmed;
  }
}

const elasticsearchDocumentProvider: DocumentStoreProvider = {
  kind: "elasticsearch",
  filterInputLabel: "filter",
  sortInputLabel: "sort",
  documentsLabel: () => "Documents",
  queryPreview: ({ collection, filterJson, sortJson, skip, limit }) => {
    const body = safeElasticsearchSearchBodyFromDocumentQuery({ filterJson, sortJson, skip, limit });
    return `POST /${collection}/_search\n${JSON.stringify(body, null, 2)}`;
  },
  sortInputForColumn: mongoDocumentProvider.sortInputForColumn,
};

export function documentStoreProviderFor(databaseType?: DatabaseType): DocumentStoreProvider {
  return databaseType === "elasticsearch" ? elasticsearchDocumentProvider : mongoDocumentProvider;
}

export function defaultDocumentFilterRule(id: string, fieldName = ""): DocumentFilterRule {
  return {
    id,
    fieldName,
    mode: "equals",
    rawValue: "",
    conjunction: "AND",
    elasticsearchClause: "filter",
    elasticsearchQueryType: "term",
  };
}

export function documentFilterModeNeedsValue(mode: DocumentFilterMode): boolean {
  return mode !== "is-null" && mode !== "is-not-null";
}

type DocumentFieldPathAccumulatorNode = {
  key: string;
  path: string;
  kind: DocumentFieldPathKind;
  sampleValue?: unknown;
  children: DocumentFieldPathAccumulatorNode[];
  childByKey: Map<string, DocumentFieldPathAccumulatorNode>;
};

export function documentFieldPathOptionsFromDocuments(documents: readonly Record<string, unknown>[]): string[] {
  return flattenDocumentFieldPathTree(documentFieldPathTreeFromDocuments(documents)).map((node) => node.path);
}

export function documentFieldPathTreeFromDocuments(documents: readonly Record<string, unknown>[]): DocumentFieldPathNode[] {
  if (documents.length === 0) return [];
  const rootNodes: DocumentFieldPathAccumulatorNode[] = [];
  const rootByKey = new Map<string, DocumentFieldPathAccumulatorNode>();
  ensureDocumentFieldPathNode(rootNodes, rootByKey, "_id", "_id", "scalar");

  for (const doc of documents) {
    for (const [key, value] of Object.entries(doc)) {
      if (key === "_id") continue;
      collectDocumentFieldPathNode(rootNodes, rootByKey, key, value);
    }
  }
  return finalizeDocumentFieldPathNodes(rootNodes);
}

export function flattenDocumentFieldPathTree(nodes: readonly DocumentFieldPathNode[]): DocumentFieldPathNode[] {
  const flattened: DocumentFieldPathNode[] = [];
  for (const node of nodes) {
    flattened.push(node);
    flattened.push(...flattenDocumentFieldPathTree(node.children));
  }
  return flattened;
}

export function searchDocumentFieldPathTree(nodes: readonly DocumentFieldPathNode[], query: string): DocumentFieldPathNode[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return flattenDocumentFieldPathTree(nodes);
  return flattenDocumentFieldPathTree(nodes).filter((node) => {
    return node.path.toLowerCase().includes(normalizedQuery) || node.displayPath.toLowerCase().includes(normalizedQuery) || node.label.toLowerCase().includes(normalizedQuery);
  });
}

export function arrayObjectAncestorPathForDocumentField(nodes: readonly DocumentFieldPathNode[], path: string): string | null {
  for (const node of nodes) {
    if (node.path === path) return null;
    if (path.startsWith(`${node.path}.`)) {
      if (node.kind === "array-object") return node.path;
      return arrayObjectAncestorPathForDocumentField(node.children, path);
    }
  }
  return null;
}

function collectDocumentFieldPathNode(nodes: DocumentFieldPathAccumulatorNode[], byKey: Map<string, DocumentFieldPathAccumulatorNode>, path: string, value: unknown, depth = 0): void {
  const key = path.split(".").pop() || path;
  const node = ensureDocumentFieldPathNode(nodes, byKey, key, path, documentFieldPathKindFromValue(value));
  if (node.sampleValue === undefined) node.sampleValue = value;
  if (depth >= 6) return;
  if (isBsonExtendedJsonWrapper(value)) return;
  if (Array.isArray(value)) {
    collectArrayDocumentFieldPathNodes(node, value, depth + 1);
    return;
  }
  if (isPlainRecord(value)) collectNestedDocumentFieldPathNodes(node, value, depth + 1);
}

function collectArrayDocumentFieldPathNodes(parent: DocumentFieldPathAccumulatorNode, values: readonly unknown[], depth: number): void {
  if (depth > 6) return;
  for (const value of values) {
    if (Array.isArray(value)) collectArrayDocumentFieldPathNodes(parent, value, depth + 1);
    else if (isPlainRecord(value) && !isBsonExtendedJsonWrapper(value)) collectNestedDocumentFieldPathNodes(parent, value, depth);
  }
}

function collectNestedDocumentFieldPathNodes(parent: DocumentFieldPathAccumulatorNode, value: Record<string, unknown>, depth: number): void {
  for (const [key, nestedValue] of Object.entries(value)) {
    collectDocumentFieldPathNode(parent.children, parent.childByKey, `${parent.path}.${key}`, nestedValue, depth);
  }
}

function ensureDocumentFieldPathNode(nodes: DocumentFieldPathAccumulatorNode[], byKey: Map<string, DocumentFieldPathAccumulatorNode>, key: string, path: string, kind: DocumentFieldPathKind): DocumentFieldPathAccumulatorNode {
  const existing = byKey.get(key);
  if (existing) {
    existing.kind = mergeDocumentFieldPathKind(existing.kind, kind);
    return existing;
  }
  const node: DocumentFieldPathAccumulatorNode = {
    key,
    path,
    kind,
    children: [],
    childByKey: new Map(),
  };
  byKey.set(key, node);
  nodes.push(node);
  return node;
}

function documentFieldPathKindFromValue(value: unknown): DocumentFieldPathKind {
  if (isBsonExtendedJsonWrapper(value)) return "scalar";
  if (Array.isArray(value)) return arrayContainsPlainRecord(value) ? "array-object" : "array";
  if (isPlainRecord(value)) return "object";
  return "scalar";
}

const BSON_EXTENDED_JSON_SINGLE_KEY_WRAPPERS = new Set(["$oid", "$numberInt", "$numberLong", "$numberDouble", "$numberDecimal", "$date", "$timestamp", "$binary", "$regularExpression", "$code", "$symbol", "$undefined", "$minKey", "$maxKey", "$dbPointer"]);

function isBsonExtendedJsonWrapper(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  if (keys.length === 1) return BSON_EXTENDED_JSON_SINGLE_KEY_WRAPPERS.has(keys[0]);
  return (keys.length === 2 && keys.includes("$binary") && keys.includes("$type")) || (keys.length === 2 && keys.includes("$code") && keys.includes("$scope")) || (keys.length === 2 && keys.includes("$dbPointer") && keys.includes("$ref"));
}

function arrayContainsPlainRecord(values: readonly unknown[]): boolean {
  return values.some((value) => (isPlainRecord(value) && !isBsonExtendedJsonWrapper(value)) || (Array.isArray(value) && arrayContainsPlainRecord(value)));
}

function mergeDocumentFieldPathKind(current: DocumentFieldPathKind, next: DocumentFieldPathKind): DocumentFieldPathKind {
  if (current === next) return current;
  if (current === "mixed" || next === "mixed") return "mixed";
  if ((current === "array-object" && next === "array") || (current === "array" && next === "array-object")) return "array-object";
  return "mixed";
}

function finalizeDocumentFieldPathNodes(nodes: readonly DocumentFieldPathAccumulatorNode[], parentDisplaySegments: readonly string[] = []): DocumentFieldPathNode[] {
  return nodes.map((node) => {
    const label = node.kind === "array" || node.kind === "array-object" ? `${node.key}[]` : node.key;
    const displaySegments = [...parentDisplaySegments, label];
    return {
      key: node.key,
      path: node.path,
      label,
      displayPath: displaySegments.join(" > "),
      kind: node.kind,
      selectable: true,
      sampleValue: node.sampleValue,
      children: finalizeDocumentFieldPathNodes(node.children, displaySegments),
    };
  });
}

export function elasticsearchQueryTypeNeedsValue(queryType: ElasticsearchQueryType | undefined): boolean {
  return queryType !== "exists";
}

export function buildElasticsearchQueryFromRules(rules: readonly DocumentFilterRule[]): Record<string, unknown> | null {
  const boolQuery: Partial<Record<ElasticsearchBoolClause, Record<string, unknown>[]>> & { minimum_should_match?: number } = {};

  for (const rule of rules) {
    const query = buildElasticsearchRuleQuery(rule);
    if (!query) continue;
    const clause = rule.elasticsearchClause ?? "filter";
    (boolQuery[clause] ??= []).push(query);
  }

  if (Object.keys(boolQuery).length === 0) return null;
  if (boolQuery.should?.length) boolQuery.minimum_should_match = 1;
  return { bool: boolQuery };
}

function buildElasticsearchRuleQuery(rule: DocumentFilterRule): Record<string, unknown> | null {
  const field = rule.fieldName.trim();
  const queryType = rule.elasticsearchQueryType ?? "term";
  if (!field || (elasticsearchQueryTypeNeedsValue(queryType) && !rule.rawValue.trim())) return null;

  if (queryType === "exists") return { exists: { field } };
  const value = parseDocumentFilterValue(rule.rawValue, { kind: "elasticsearch" });
  switch (queryType) {
    case "term":
      return { term: { [field]: value } };
    case "terms": {
      const values = Array.isArray(value)
        ? value
        : rule.rawValue
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
            .map((item) => parseDocumentFilterValue(item, { kind: "elasticsearch" }));
      return values.length ? { terms: { [field]: values } } : null;
    }
    case "match":
      return { match: { [field]: value } };
    case "match_phrase":
      return { match_phrase: { [field]: value } };
    case "wildcard":
      // Keep the compact form compatible with every supported Elasticsearch 7.x release.
      // `case_insensitive` was only added in Elasticsearch 7.10.
      return { wildcard: { [field]: String(value) } };
    case "range_gt":
      return { range: { [field]: { gt: value } } };
    case "range_gte":
      return { range: { [field]: { gte: value } } };
    case "range_lt":
      return { range: { [field]: { lt: value } } };
    case "range_lte":
      return { range: { [field]: { lte: value } } };
  }
}

export function elasticsearchStructuredFilter(query: Record<string, unknown> | null): Record<string, unknown> | null {
  return query ? { $esQuery: query } : null;
}

type DocumentFilterParseOptions = {
  kind?: DocumentStoreKind;
  sampleValue?: unknown;
};

export function buildDocumentFilterCondition(rule: DocumentFilterRule, options: DocumentFilterParseOptions = {}): Record<string, unknown> | null {
  if (!rule.fieldName) return null;
  if (documentFilterModeNeedsValue(rule.mode) && !rule.rawValue.trim()) return null;
  const value = documentFilterModeNeedsValue(rule.mode) ? parseDocumentFilterValue(rule.rawValue, options) : null;
  const textValue = documentFilterModeNeedsValue(rule.mode) ? String(parseDocumentFilterValue(rule.rawValue)) : "";
  switch (rule.mode) {
    case "equals":
      return { [rule.fieldName]: value };
    case "not-equals":
      return { [rule.fieldName]: { $ne: value } };
    case "like":
      return { [rule.fieldName]: { $regex: escapeRegexLiteral(textValue), $options: "i" } };
    case "not-like":
      return { [rule.fieldName]: { $not: { $regex: escapeRegexLiteral(textValue), $options: "i" } } };
    case "greater-than":
      return { [rule.fieldName]: { $gt: value } };
    case "less-than":
      return { [rule.fieldName]: { $lt: value } };
    case "is-null":
      return { [rule.fieldName]: null };
    case "is-not-null":
      return { [rule.fieldName]: { $ne: null } };
  }
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function combineDocumentFilterConditions(conditions: Record<string, unknown>[], rules: Pick<DocumentFilterRule, "conjunction">[], arrayObjectParents: Array<string | null> = []): Record<string, unknown> | null {
  if (conditions.length === 0) return null;
  const grouped = groupLeadingArrayObjectConditions(conditions, rules, arrayObjectParents);
  let result = grouped.conditions[0];
  for (let i = 1; i < grouped.conditions.length; i++) {
    const operator = grouped.rules[i]?.conjunction === "OR" ? "$or" : "$and";
    result = { [operator]: [result, grouped.conditions[i]] };
  }
  return result;
}

function groupLeadingArrayObjectConditions(conditions: Record<string, unknown>[], rules: Pick<DocumentFilterRule, "conjunction">[], arrayObjectParents: Array<string | null>): { conditions: Record<string, unknown>[]; rules: Pick<DocumentFilterRule, "conjunction">[] } {
  const groupedConditions: Record<string, unknown>[] = [];
  const groupedRules: Pick<DocumentFilterRule, "conjunction">[] = [];
  let index = 0;

  // A later AND after an OR is part of the left-associated expression produced below,
  // so only the prefix before the first OR can be safely collapsed into $elemMatch.
  while (index < conditions.length && (index === 0 || rules[index]?.conjunction !== "OR")) {
    const parent = arrayObjectParents[index];
    if (!parent) {
      groupedConditions.push(conditions[index]);
      groupedRules.push(rules[index]);
      index++;
      continue;
    }

    const elementConditions: Record<string, unknown>[] = [];
    let end = index;
    while (end < conditions.length && (end === index || rules[end]?.conjunction === "AND") && arrayObjectParents[end] === parent) {
      const relative = relativeArrayObjectCondition(conditions[end], parent);
      if (!relative) break;
      elementConditions.push(relative);
      end++;
    }
    if (elementConditions.length < 2) {
      groupedConditions.push(conditions[index]);
      groupedRules.push(rules[index]);
      index++;
      continue;
    }
    groupedConditions.push({ [parent]: { $elemMatch: { $and: elementConditions } } });
    groupedRules.push(rules[index]);
    index = end;
  }

  return {
    conditions: [...groupedConditions, ...conditions.slice(index)],
    rules: [...groupedRules, ...rules.slice(index)],
  };
}

function relativeArrayObjectCondition(condition: Record<string, unknown>, parent: string): Record<string, unknown> | null {
  const entries = Object.entries(condition);
  if (entries.length !== 1) return null;
  const [field, value] = entries[0];
  const prefix = `${parent}.`;
  return field.startsWith(prefix) ? { [field.slice(prefix.length)]: value } : null;
}

const MAX_SAFE_BIGINT = 9007199254740991n;
const MIN_BSON_INT64 = -9223372036854775808n;
const MAX_BSON_INT64 = 9223372036854775807n;

function parseJsonPreservingLargeIntegers(json: string, options: DocumentFilterParseOptions = {}): unknown {
  return JSON.parse(rewriteUnsafeIntegerTokens(json, options));
}

function rewriteUnsafeIntegerTokens(json: string, options: DocumentFilterParseOptions): string {
  let output = "";
  let i = 0;
  while (i < json.length) {
    const ch = json[i];
    if (ch === '"') {
      const start = i;
      i++;
      while (i < json.length) {
        const current = json[i++];
        if (current === "\\") {
          i++;
        } else if (current === '"') {
          break;
        }
      }
      output += json.slice(start, i);
      continue;
    }

    if (ch === "-" || isDigit(ch)) {
      const start = i;
      let end = i;
      if (json[end] === "-") end++;
      if (!isDigit(json[end])) {
        output += ch;
        i++;
        continue;
      }

      if (json[end] === "0") {
        end++;
      } else {
        while (isDigit(json[end])) end++;
      }

      let decimalOrExponent = false;
      if (json[end] === ".") {
        decimalOrExponent = true;
        end++;
        while (isDigit(json[end])) end++;
      }
      if (json[end] === "e" || json[end] === "E") {
        decimalOrExponent = true;
        end++;
        if (json[end] === "+" || json[end] === "-") end++;
        while (isDigit(json[end])) end++;
      }

      const token = json.slice(start, end);
      if (!decimalOrExponent) {
        try {
          const n = BigInt(token);
          if (n > MAX_SAFE_BIGINT || n < -MAX_SAFE_BIGINT) {
            output += unsafeIntegerReplacement(token, n, options);
            i = end;
            continue;
          }
        } catch {
          /* not a valid integer */
        }
      }

      output += token;
      i = end;
      continue;
    }

    output += ch;
    i++;
  }
  return output;
}

function unsafeIntegerReplacement(token: string, value: bigint, options: DocumentFilterParseOptions): string {
  if (options.kind === "mongodb" && value >= MIN_BSON_INT64 && value <= MAX_BSON_INT64) {
    // MongoDB int64 filters must use Extended JSON so JS Number never rounds snowflake-style IDs.
    return `{"$numberLong":${JSON.stringify(token)}}`;
  }
  return JSON.stringify(token);
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

export function parseDocumentFilterInput(input: string, options: DocumentFilterParseOptions = {}): Record<string, unknown> {
  const trimmed = input.trim();
  if (!trimmed) return {};
  const safe = normalizeDocumentQueryObjectInput(trimmed, options.kind);
  const parsed = parseJsonPreservingLargeIntegers(safe, options);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

type DocumentQueryInputNormalizer = (input: string) => string | null;

const documentQueryInputNormalizers: Record<DocumentStoreKind, DocumentQueryInputNormalizer> = {
  mongodb: normalizeJsonArgument,
  elasticsearch: quoteUnquotedObjectKeys,
};

function normalizeDocumentQueryObjectInput(input: string, kind?: DocumentStoreKind): string {
  const normalize = kind ? documentQueryInputNormalizers[kind] : quoteUnquotedObjectKeys;
  return normalize(input) ?? input;
}

export function currentDocumentFilterJson(input: string, structured: Record<string, unknown> | null, kind?: DocumentStoreKind): string | undefined {
  const manual = parseDocumentFilterInput(input, { kind });
  const filter = structured ? (Object.keys(manual).length ? { $and: [manual, structured] } : structured) : manual;
  return Object.keys(filter).length ? JSON.stringify(filter) : undefined;
}

export function currentDocumentSortJson(input: string): string | undefined {
  const sort = parseDocumentFilterInput(input);
  return Object.keys(sort).length ? JSON.stringify(sort) : undefined;
}

export function formatDocumentQueryInput(input: string, kind?: DocumentStoreKind): string {
  const parsed = parseDocumentFilterInput(input, { kind });
  return JSON.stringify(parsed, null, 2);
}

function parseDocumentFilterValue(raw: string, options: DocumentFilterParseOptions = {}): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return parseJsonPreservingLargeIntegers(trimmed, options);
  } catch {
    return mongoTypedFilterValue(trimmed, options);
  }
}

function mongoTypedFilterValue(raw: string, options: DocumentFilterParseOptions): unknown {
  if (options.kind !== "mongodb") return raw;
  const sampleValue = mongoTypedFilterSample(options.sampleValue);
  if (!sampleValue) return raw;
  if (typeof sampleValue.$oid === "string") return { $oid: raw };
  if ("$date" in sampleValue) return { $date: raw };
  if (typeof sampleValue.$numberLong === "string" && /^-?\d+$/.test(raw)) return { $numberLong: raw };
  return raw;
}

function mongoTypedFilterSample(sampleValue: unknown): Record<string, unknown> | null {
  if (isPlainRecord(sampleValue)) return sampleValue;
  if (!Array.isArray(sampleValue)) return null;

  const samples = sampleValue.filter((value) => value !== null && value !== undefined);
  if (!samples.length || samples.some((value) => !isPlainRecord(value))) return null;
  const records = samples as Record<string, unknown>[];
  const sampleKind = mongoTypedFilterSampleKind(records[0]);
  // Mixed arrays are ambiguous, so infer a BSON type only from homogeneous scalar wrappers.
  if (!sampleKind || records.some((value) => mongoTypedFilterSampleKind(value) !== sampleKind)) return null;
  return records[0];
}

function mongoTypedFilterSampleKind(sampleValue: Record<string, unknown>): "$oid" | "$date" | "$numberLong" | null {
  if (typeof sampleValue.$oid === "string") return "$oid";
  if ("$date" in sampleValue) return "$date";
  if (typeof sampleValue.$numberLong === "string") return "$numberLong";
  return null;
}

export function elasticsearchSearchBodyFromDocumentQuery(options: Pick<DocumentStoreQueryPreviewOptions, "filterJson" | "sortJson" | "skip" | "limit">): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from: options.skip,
    size: options.limit,
  };
  const query = elasticsearchQueryFromDocumentFilter(options.filterJson);
  if (query) body.query = query;
  body.sort = elasticsearchSortFromDocumentSort(options.sortJson);
  return body;
}

function safeElasticsearchSearchBodyFromDocumentQuery(options: Pick<DocumentStoreQueryPreviewOptions, "filterJson" | "sortJson" | "skip" | "limit">): Record<string, unknown> {
  try {
    return elasticsearchSearchBodyFromDocumentQuery(options);
  } catch {
    return {
      from: options.skip,
      size: options.limit,
      sort: ["_doc"],
    };
  }
}

function elasticsearchQueryFromDocumentFilter(filterJson?: string): Record<string, unknown> | null {
  const trimmed = filterJson?.trim();
  if (!trimmed || trimmed === "{}") return null;
  const parsed = JSON.parse(trimmed);
  if (!isPlainRecord(parsed) || Object.keys(parsed).length === 0) return null;
  return translateDocumentFilterToElasticsearchQuery(parsed);
}

function translateDocumentFilterToElasticsearchQuery(filter: Record<string, unknown>): Record<string, unknown> {
  const filters: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and") {
      filters.push(...translateLogicalArrayToElasticsearch("$and", value));
    } else if (key === "$or") {
      const should = translateLogicalArrayToElasticsearch("$or", value);
      if (should.length > 0) filters.push({ bool: { should, minimum_should_match: 1 } });
    } else if (key === "$esQuery") {
      if (!isPlainRecord(value)) throw new Error("$esQuery must be an object");
      filters.push(value);
    } else {
      filters.push(translateFieldFilterToElasticsearchQuery(key, value));
    }
  }
  if (filters.length === 1) return filters[0];
  return { bool: { filter: filters } };
}

function translateLogicalArrayToElasticsearch(operator: "$and" | "$or", value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${operator} must be an array`);
  return value.filter(isPlainRecord).map(translateDocumentFilterToElasticsearchQuery);
}

function translateFieldFilterToElasticsearchQuery(field: string, value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value) || !Object.keys(value).some((key) => key.startsWith("$"))) {
    return termOrNullQuery(field, value);
  }

  const filter: Record<string, unknown>[] = [];
  const mustNot: Record<string, unknown>[] = [];
  const range: Record<string, unknown> = {};
  for (const [operator, operatorValue] of Object.entries(value)) {
    if (operator === "$options") continue;
    if (operator === "$ne") {
      if (operatorValue === null) filter.push({ exists: { field } });
      else mustNot.push({ term: { [field]: operatorValue } });
    } else if (operator === "$gt" || operator === "$gte" || operator === "$lt" || operator === "$lte") {
      range[operator.slice(1)] = operatorValue;
    } else if (operator === "$regex") {
      filter.push(wildcardQuery(field, operatorValue, value.$options));
    } else if (operator === "$not") {
      if (isPlainRecord(operatorValue) && "$regex" in operatorValue) {
        mustNot.push(wildcardQuery(field, operatorValue.$regex, operatorValue.$options ?? value.$options));
      }
    }
  }
  if (Object.keys(range).length > 0) filter.push({ range: { [field]: range } });
  if (filter.length === 1 && mustNot.length === 0) return filter[0];
  if (filter.length === 0 && mustNot.length > 0) return { bool: { must_not: mustNot } };
  const bool: Record<string, unknown> = {};
  if (filter.length > 0) bool.filter = filter;
  if (mustNot.length > 0) bool.must_not = mustNot;
  return { bool };
}

function termOrNullQuery(field: string, value: unknown): Record<string, unknown> {
  if (value === null) return { bool: { must_not: [{ exists: { field } }] } };
  return { term: { [field]: value } };
}

function wildcardQuery(field: string, value: unknown, options: unknown): Record<string, unknown> {
  const pattern = String(value ?? "");
  const wildcard = pattern.startsWith("*") || pattern.endsWith("*") ? pattern : `*${pattern}*`;
  return {
    wildcard: {
      [field]: {
        value: wildcard,
        case_insensitive: typeof options === "string" && options.toLowerCase().includes("i"),
      },
    },
  };
}

function elasticsearchSortFromDocumentSort(sortJson?: string): unknown[] {
  const trimmed = sortJson?.trim();
  if (!trimmed || trimmed === "{}") return ["_doc"];
  const parsed = JSON.parse(trimmed);
  if (!isPlainRecord(parsed)) return ["_doc"];
  return Object.entries(parsed).map(([field, direction]) => ({
    [field]: { order: direction === -1 || (typeof direction === "string" && direction.toLowerCase() === "desc") ? "desc" : "asc" },
  }));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
