export type MongoCompletionMode = "root" | "collection" | "method" | "cursorMethod" | "field" | "operator" | "stage";

export interface MongoCompletionField {
  name: string;
  type?: string;
}

export interface MongoCompletionItem {
  label: string;
  type: "column" | "function" | "keyword" | "snippet" | "table";
  detail?: string;
  info?: string;
  apply?: string;
  boost: number;
}

export interface MongoCompletionContext {
  mode: MongoCompletionMode;
  prefix: string;
  from: number;
  collection?: string;
}

export interface MongoCompletionInput {
  collections?: string[];
  fields?: MongoCompletionField[];
}

const COLLECTION_METHODS = [
  { label: "find", detail: "Query matching documents", apply: "find({})" },
  { label: "findOne", detail: "Query one matching document", apply: "findOne({})" },
  { label: "aggregate", detail: "Run an aggregation pipeline", apply: "aggregate([])" },
  { label: "countDocuments", detail: "Count matching documents", apply: "countDocuments({})" },
  { label: "distinct", detail: "Return distinct field values", apply: 'distinct("${field}", {})' },
  { label: "insertOne", detail: "Insert one document", apply: "insertOne({})" },
  { label: "insertMany", detail: "Insert multiple documents", apply: "insertMany([{}])" },
  { label: "updateOne", detail: "Update one matching document", apply: "updateOne({}, { $set: {} })" },
  { label: "updateMany", detail: "Update all matching documents", apply: "updateMany({}, { $set: {} })" },
  { label: "deleteOne", detail: "Delete one matching document", apply: "deleteOne({})" },
  { label: "deleteMany", detail: "Delete all matching documents", apply: "deleteMany({})" },
  { label: "getIndexes", detail: "List collection indexes", apply: "getIndexes()" },
  { label: "createIndex", detail: "Create an index", apply: "createIndex({ ${field}: 1 })" },
  { label: "dropIndex", detail: "Drop one index", apply: 'dropIndex("${indexName}")' },
  { label: "dropIndexes", detail: "Drop collection indexes", apply: "dropIndexes()" },
] as const;

const CURSOR_METHODS = [
  { label: "sort", detail: "Sort cursor results", apply: "sort({ ${field}: 1 })" },
  { label: "limit", detail: "Limit cursor results", apply: "limit(100)" },
  { label: "skip", detail: "Skip cursor results", apply: "skip(0)" },
] as const;

const ROOT_SNIPPETS = [
  { label: "db.collection.find", detail: "Find documents", apply: "db.${collection}.find({})" },
  { label: "db.collection.aggregate", detail: "Aggregation pipeline", apply: "db.${collection}.aggregate([\n  { $match: {} }\n])" },
  { label: "db.getCollection", detail: "Reference a collection by name", apply: 'db.getCollection("${collection}")' },
] as const;

const FIELD_SNIPPETS = [
  { label: "ObjectId", detail: "MongoDB ObjectId value", apply: 'ObjectId("${id}")' },
  { label: "ISODate", detail: "MongoDB ISODate value", apply: 'ISODate("${date}")' },
  { label: "$regex", detail: "Regular expression match", apply: '$regex: "${pattern}"' },
  { label: "$in", detail: "Match any value in array", apply: "$in: []" },
  { label: "$gte", detail: "Greater than or equal", apply: "$gte: ${value}" },
  { label: "$lte", detail: "Less than or equal", apply: "$lte: ${value}" },
] as const;

const QUERY_OPERATORS = ["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$exists", "$regex", "$and", "$or", "$nor", "$not", "$elemMatch"];
const UPDATE_OPERATORS = ["$set", "$unset", "$inc", "$push", "$pull", "$addToSet", "$rename", "$currentDate", "$setOnInsert"];
const PIPELINE_STAGES = ["$match", "$project", "$group", "$sort", "$limit", "$skip", "$unwind", "$lookup", "$addFields", "$count", "$facet"];
const QUERY_METHODS = ["find", "findOne", "countDocuments", "updateOne", "updateMany", "deleteOne", "deleteMany", "dropIndex", "dropIndexes", "sort"];

export function getMongoCompletionContext(text: string, cursor: number): MongoCompletionContext {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const operatorPrefix = readOperatorPrefix(text, safeCursor);
  const collection = extractActiveCollection(text, safeCursor);

  if (operatorPrefix) {
    return {
      mode: isLikelyAggregationPipeline(text, safeCursor) ? "stage" : "operator",
      prefix: operatorPrefix.prefix,
      from: operatorPrefix.from,
      collection,
    };
  }

  const propertyPrefix = readPropertyPrefix(text, safeCursor);
  const beforeCursor = text.slice(0, safeCursor);

  if (isInsideOperatorValueObject(beforeCursor)) {
    return { mode: "operator", prefix: propertyPrefix.prefix, from: propertyPrefix.from, collection };
  }

  if (/db\.$/.test(beforeCursor)) {
    return { mode: "collection", prefix: "", from: safeCursor, collection };
  }

  const collectionPrefix = matchDbCollectionPrefix(beforeCursor);
  if (collectionPrefix) {
    return { mode: "collection", prefix: collectionPrefix.prefix, from: collectionPrefix.from, collection };
  }

  if (isAfterCollectionDot(beforeCursor)) {
    const methodPrefix = readMethodPrefix(beforeCursor);
    return { mode: "method", prefix: methodPrefix.prefix, from: methodPrefix.from, collection };
  }

  if (isAfterCursorMethodDot(beforeCursor)) {
    const methodPrefix = readMethodPrefix(beforeCursor);
    return { mode: "cursorMethod", prefix: methodPrefix.prefix, from: methodPrefix.from, collection };
  }

  if (isLikelyFieldPosition(text, safeCursor)) {
    return { mode: "field", prefix: propertyPrefix.prefix, from: propertyPrefix.from, collection };
  }

  return { mode: "root", prefix: propertyPrefix.prefix, from: propertyPrefix.from, collection };
}

export function buildMongoCompletionItems(text: string, cursor: number, input: MongoCompletionInput = {}): MongoCompletionItem[] {
  return buildMongoCompletionItemsFromContext(getMongoCompletionContext(text, cursor), input);
}

export function buildMongoCompletionItemsFromContext(context: MongoCompletionContext, input: MongoCompletionInput = {}): MongoCompletionItem[] {
  if (context.mode === "collection") return collectionItems(context.prefix, input.collections ?? []);
  if (context.mode === "method") return methodItems(context.prefix);
  if (context.mode === "cursorMethod") return cursorMethodItems(context.prefix);
  if (context.mode === "field") return fieldItems(context.prefix, input.fields ?? []);
  if (context.mode === "operator") return operatorItems(context.prefix);
  if (context.mode === "stage") return stageItems(context.prefix);
  return rootItems(context.prefix);
}

export function shouldAutoOpenMongoCompletion(text: string, cursor: number): boolean {
  const previousChar = text[cursor - 1];
  if (!previousChar) return false;
  if (/db\.$/.test(text.slice(0, cursor))) return true;
  if (previousChar === "$" || previousChar === "." || previousChar === '"') return true;
  if (/[{,[]/.test(previousChar)) return isLikelyFieldPosition(text, cursor) || isLikelyAggregationPipeline(text, cursor);
  if (/[\w_$.-]/.test(previousChar)) return true;
  return false;
}

export function getMongoCompletionResultValidFor(): RegExp {
  return /[\w_$.-]*$/;
}

export function inferMongoCompletionFields(documents: unknown[]): MongoCompletionField[] {
  const typeByPath = new Map<string, Set<string>>();
  for (const doc of documents) collectFieldTypes(doc, "", typeByPath, 0);
  return [...typeByPath.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, types]) => ({ name, type: [...types].sort().join(" | ") }));
}

function rootItems(prefix: string): MongoCompletionItem[] {
  const snippets = ROOT_SNIPPETS.filter((snippet) => matchesFuzzyPrefix(snippet.label, prefix)).map((snippet) => ({
    label: snippet.label,
    type: "snippet" as const,
    detail: snippet.detail,
    apply: snippet.apply,
    boost: 120,
  }));
  const methods = [...COLLECTION_METHODS, ...CURSOR_METHODS]
    .filter((method) => matchesFuzzyPrefix(method.label, prefix))
    .map((method) => ({
      label: method.label,
      type: "function" as const,
      detail: method.detail,
      apply: method.apply,
      boost: 100,
    }));
  return dedupeAndSort([...snippets, ...methods]);
}

function collectionItems(prefix: string, collections: string[]): MongoCompletionItem[] {
  return collections
    .filter((collection) => matchesFuzzyPrefix(collection, prefix))
    .slice(0, 100)
    .map((collection) => ({
      label: collection,
      type: "table" as const,
      detail: "collection",
      apply: needsGetCollectionSyntax(collection) ? `getCollection("${escapeDoubleQuoted(collection)}")` : collection,
      boost: collection.toLowerCase().startsWith(prefix.toLowerCase()) ? 120 : 90,
    }));
}

function methodItems(prefix: string): MongoCompletionItem[] {
  return dedupeAndSort(
    [...COLLECTION_METHODS, ...CURSOR_METHODS]
      .filter((method) => matchesFuzzyPrefix(method.label, prefix))
      .map((method) => ({
        label: method.label,
        type: "function" as const,
        detail: method.detail,
        apply: method.apply,
        boost: method.label === "find" || method.label === "aggregate" ? 130 : 100,
      })),
  );
}

function cursorMethodItems(prefix: string): MongoCompletionItem[] {
  return dedupeAndSort(
    CURSOR_METHODS.filter((method) => matchesFuzzyPrefix(method.label, prefix)).map((method) => ({
      label: method.label,
      type: "function" as const,
      detail: method.detail,
      apply: method.apply,
      boost: method.label === "limit" ? 130 : 110,
    })),
  );
}

function fieldItems(prefix: string, fields: MongoCompletionField[]): MongoCompletionItem[] {
  const normalizedPrefix = normalizeMongoKeyPrefix(prefix);
  const observedFields = fields
    .filter((field) => matchesFuzzyPrefix(field.name, normalizedPrefix))
    .slice(0, 100)
    .map((field) => ({
      label: field.name,
      type: "column" as const,
      detail: field.type ? `observed field · ${field.type}` : "observed field",
      apply: mongoFieldApplyText(field.name, prefix),
      boost: field.name.toLowerCase().startsWith(normalizedPrefix.toLowerCase()) ? 120 : 85,
    }));
  const snippets = FIELD_SNIPPETS.filter((snippet) => matchesFuzzyPrefix(snippet.label, normalizedPrefix)).map((snippet) => ({
    label: snippet.label,
    type: "snippet" as const,
    detail: snippet.detail,
    apply: snippet.apply,
    boost: 95,
  }));
  return dedupeAndSort([...observedFields, ...snippets]);
}

function operatorItems(prefix: string): MongoCompletionItem[] {
  return [...QUERY_OPERATORS, ...UPDATE_OPERATORS]
    .filter((operator) => matchesFuzzyPrefix(operator, prefix))
    .map((operator) => ({
      label: operator,
      type: "keyword" as const,
      detail: operator.startsWith("$set") || UPDATE_OPERATORS.includes(operator) ? "update operator" : "query operator",
      apply: operator,
      boost: operator === "$set" || operator === "$match" ? 115 : 90,
    }));
}

function stageItems(prefix: string): MongoCompletionItem[] {
  const stages = PIPELINE_STAGES.filter((stage) => matchesFuzzyPrefix(stage, prefix)).map((stage) => ({
    label: stage,
    type: "keyword" as const,
    detail: "aggregation stage",
    apply: stage,
    boost: stage === "$match" || stage === "$project" ? 120 : 95,
  }));
  const snippets = [
    { label: "$match stage", apply: "$match: {}", detail: "Filter documents in a pipeline" },
    { label: "$group stage", apply: '$group: { _id: "$${field}", count: { $sum: 1 } }', detail: "Group documents" },
    { label: "$lookup stage", apply: '$lookup: { from: "${collection}", localField: "${field}", foreignField: "_id", as: "${as}" }', detail: "Join another collection" },
  ]
    .filter((snippet) => matchesFuzzyPrefix(snippet.label, prefix))
    .map((snippet) => ({ ...snippet, type: "snippet" as const, boost: 110 }));
  return dedupeAndSort([...snippets, ...stages]);
}

function readPropertyPrefix(text: string, cursor: number): { prefix: string; from: number } {
  let from = cursor;
  while (from > 0 && /[\w_$.-]/.test(text[from - 1] ?? "")) from--;
  if (text[from - 1] === '"' || text[from - 1] === "'") from--;
  return { prefix: text.slice(from, cursor), from };
}

function readOperatorPrefix(text: string, cursor: number): { prefix: string; from: number } | null {
  let from = cursor;
  while (from > 0 && /[\w$]/.test(text[from - 1] ?? "")) from--;
  const prefix = text.slice(from, cursor);
  return prefix.startsWith("$") ? { prefix, from } : null;
}

function readMethodPrefix(beforeCursor: string): { prefix: string; from: number } {
  const dot = beforeCursor.lastIndexOf(".");
  const from = dot >= 0 ? dot + 1 : beforeCursor.length;
  return { prefix: beforeCursor.slice(from), from };
}

function matchDbCollectionPrefix(beforeCursor: string): { prefix: string; from: number } | null {
  const match = /(?:^|[\s;(])db\.([A-Za-z_][\w$-]*)$/.exec(beforeCursor);
  if (!match) return null;
  const prefix = match[1] ?? "";
  return { prefix, from: beforeCursor.length - prefix.length };
}

function isAfterCollectionDot(beforeCursor: string): boolean {
  return /(?:^|[\s;(])db\.(?:[A-Za-z_][\w$-]*|getCollection\(["'][^"']+["']\))\.[\w$-]*$/.test(beforeCursor);
}

function isAfterCursorMethodDot(beforeCursor: string): boolean {
  return /(?:^|[\s;(])db\.(?:[A-Za-z_][\w$-]*|getCollection\(["'][^"']+["']\))\.(?:find|aggregate)\s*\([\s\S]*\)(?:\s*\.\s*(?:sort|skip|limit)\s*\([\s\S]*\))*\s*\.\s*[\w$-]*$/.test(beforeCursor);
}

function isLikelyFieldPosition(text: string, cursor: number): boolean {
  const before = text.slice(0, cursor);
  if (!/[{,]\s*["']?[\w$.-]*$/.test(before)) return false;
  const call = findInnermostMongoCall(before);
  if (!call) return false;
  if (call.method === "aggregate") return isLikelyAggregationPipeline(text, cursor);
  if (!QUERY_METHODS.includes(call.method)) return false;
  if (isInsideOperatorValueObject(before)) return false;
  return true;
}

function isLikelyAggregationPipeline(text: string, cursor: number): boolean {
  const before = text.slice(0, cursor);
  const aggregatePos = before.lastIndexOf(".aggregate");
  if (aggregatePos < 0) return false;
  const afterAggregate = before.slice(aggregatePos);
  return afterAggregate.lastIndexOf("[") > afterAggregate.lastIndexOf("]");
}

function extractActiveCollection(text: string, cursor: number): string | undefined {
  const before = text.slice(0, cursor);
  const getCollectionMatches = [...before.matchAll(/db\.getCollection\(["']([^"']+)["']\)/g)];
  const directMatches = [...before.matchAll(/db\.([A-Za-z_][\w$-]*)\s*\./g)].filter((match) => match[1] !== "getCollection");
  const lastGetCollection = getCollectionMatches[getCollectionMatches.length - 1];
  const lastDirect = directMatches[directMatches.length - 1];
  const getCollectionIndex = lastGetCollection?.index ?? -1;
  const directIndex = lastDirect?.index ?? -1;
  if (getCollectionIndex > directIndex) return lastGetCollection?.[1];
  return lastDirect?.[1];
}

function collectFieldTypes(value: unknown, prefix: string, out: Map<string, Set<string>>, depth: number) {
  if (depth > 4 || value == null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 3)) collectFieldTypes(item, prefix, out, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!out.has(path)) out.set(path, new Set());
    out.get(path)?.add(describeMongoValueType(child));
    collectFieldTypes(child, path, out, depth + 1);
  }
}

function describeMongoValueType(value: unknown): string {
  if (value == null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  return typeof value === "object" ? "object" : typeof value;
}

function quoteMongoFieldName(field: string, prefix: string): string {
  if (prefix.startsWith('"')) return `"${escapeDoubleQuoted(field)}"`;
  if (prefix.startsWith("'")) return `'${field.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return field;
}

function mongoFieldApplyText(field: string, prefix: string): string {
  const quoted = quoteMongoFieldName(field, prefix);
  return `${quoted}: `;
}

function findInnermostMongoCall(beforeCursor: string): { method: string; openParenIndex: number } | null {
  const callPattern = /\.(find|findOne|countDocuments|updateOne|updateMany|deleteOne|deleteMany|aggregate|sort)\s*\(/g;
  let match: RegExpExecArray | null;
  let result: { method: string; openParenIndex: number } | null = null;
  while ((match = callPattern.exec(beforeCursor))) {
    const method = match[1];
    const openParenIndex = match.index + match[0].lastIndexOf("(");
    if (method) result = { method, openParenIndex };
  }
  return result;
}

function isInsideOperatorValueObject(beforeCursor: string): boolean {
  const call = findInnermostMongoCall(beforeCursor);
  if (!call) return false;
  const callArgumentsBeforeCursor = beforeCursor.slice(call.openParenIndex + 1);
  return /(?:^|[{,])\s*["']?[\w$.-]+["']?\s*:\s*\{\s*["']?[\w$.-]*$/.test(callArgumentsBeforeCursor);
}

function normalizeMongoKeyPrefix(prefix: string): string {
  return prefix.replace(/^["']/, "");
}

function needsGetCollectionSyntax(collection: string): boolean {
  return !/^[A-Za-z_][\w$]*$/.test(collection);
}

function escapeDoubleQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function matchesFuzzyPrefix(value: string, prefix: string): boolean {
  const normalizedValue = value.toLowerCase();
  const normalizedPrefix = prefix.toLowerCase().replace(/^["']/, "");
  if (!normalizedPrefix) return true;
  return normalizedValue.startsWith(normalizedPrefix) || normalizedValue.includes(normalizedPrefix);
}

function dedupeAndSort(items: MongoCompletionItem[]): MongoCompletionItem[] {
  const seen = new Set<string>();
  const deduped: MongoCompletionItem[] = [];
  for (const item of items) {
    const key = `${item.type}:${item.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped.sort((a, b) => b.boost - a.boost || a.label.localeCompare(b.label));
}
