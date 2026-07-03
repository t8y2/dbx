import type { ComposerTranslation } from "vue-i18n";
import type { DatabaseType } from "@/types/database";
import { quoteUnquotedObjectKeys } from "@/lib/mongoShellCommand";

export type DocumentStoreKind = "mongodb" | "elasticsearch";
export type DocumentFilterMode = "equals" | "not-equals" | "like" | "not-like" | "greater-than" | "less-than" | "is-null" | "is-not-null";

export type DocumentFilterRule = {
  id: string;
  fieldName: string;
  mode: DocumentFilterMode;
  rawValue: string;
  conjunction: "AND" | "OR";
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

const mongoDocumentProvider: DocumentStoreProvider = {
  kind: "mongodb",
  filterInputLabel: "find",
  sortInputLabel: "sort",
  documentsLabel: ({ total, t }) => t("mongo.documents", { count: total }),
  queryPreview: ({ collection, filterJson, sortJson, skip, limit }) => {
    const collectionRef = `db.getCollection(${JSON.stringify(collection)})`;
    const parts = [`${collectionRef}.find(${filterJson || "{}"})`];
    if (sortJson?.trim()) parts.push(`.sort(${sortJson.trim()})`);
    parts.push(`.skip(${skip}).limit(${limit})`);
    return parts.join("");
  },
  sortInputForColumn: (column, direction) => (direction ? JSON.stringify({ [column]: direction === "asc" ? 1 : -1 }) : ""),
};

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
  };
}

export function documentFilterModeNeedsValue(mode: DocumentFilterMode): boolean {
  return mode !== "is-null" && mode !== "is-not-null";
}

export function buildDocumentFilterCondition(rule: DocumentFilterRule): Record<string, unknown> | null {
  if (!rule.fieldName) return null;
  if (documentFilterModeNeedsValue(rule.mode) && !rule.rawValue.trim()) return null;
  const value = documentFilterModeNeedsValue(rule.mode) ? parseDocumentFilterValue(rule.rawValue) : null;
  switch (rule.mode) {
    case "equals":
      return { [rule.fieldName]: value };
    case "not-equals":
      return { [rule.fieldName]: { $ne: value } };
    case "like":
      return { [rule.fieldName]: { $regex: String(value), $options: "i" } };
    case "not-like":
      return { [rule.fieldName]: { $not: { $regex: String(value), $options: "i" } } };
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

export function combineDocumentFilterConditions(conditions: Record<string, unknown>[], rules: Pick<DocumentFilterRule, "conjunction">[]): Record<string, unknown> | null {
  if (conditions.length === 0) return null;
  let result = conditions[0];
  for (let i = 1; i < conditions.length; i++) {
    const operator = rules[i]?.conjunction === "OR" ? "$or" : "$and";
    result = { [operator]: [result, conditions[i]] };
  }
  return result;
}

const MAX_SAFE_BIGINT = 9007199254740991n;

function parseJsonPreservingLargeIntegers(json: string): unknown {
  const safe = json.replace(/([\[:,\s]\s*?)(-?\d+)(\s*[,\]\}])/g, (_match, before, num, after) => {
    try {
      const n = BigInt(num);
      if (n > MAX_SAFE_BIGINT || n < -MAX_SAFE_BIGINT) {
        return `${before}"${num}"${after}`;
      }
    } catch {
      /* not a valid integer */
    }
    return _match;
  });
  return JSON.parse(safe);
}

export function parseDocumentFilterInput(input: string): Record<string, unknown> {
  const trimmed = input.trim();
  if (!trimmed) return {};
  const safe = quoteUnquotedObjectKeys(trimmed);
  const parsed = parseJsonPreservingLargeIntegers(safe);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

export function currentDocumentFilterJson(input: string, structured: Record<string, unknown> | null): string | undefined {
  const manual = parseDocumentFilterInput(input);
  const filter = structured ? (Object.keys(manual).length ? { $and: [manual, structured] } : structured) : manual;
  return Object.keys(filter).length ? JSON.stringify(filter) : undefined;
}

export function currentDocumentSortJson(input: string): string | undefined {
  const sort = parseDocumentFilterInput(input);
  return Object.keys(sort).length ? JSON.stringify(sort) : undefined;
}

function parseDocumentFilterValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return parseJsonPreservingLargeIntegers(trimmed);
  } catch {
    return trimmed;
  }
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
