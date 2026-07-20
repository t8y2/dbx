import { ACCUMULATORS, COMMON_OPERATORS, EXPRESSION_OPERATORS, PIPELINE_STAGES, PUSH_MODIFIERS, QUERY_OPERATORS, STAGE_OPTION_KEYS, UPDATE_OPERATORS, UPDATE_OPERATOR_LABELS, VALUE_SNIPPETS, mongoOperatorItemType, type MongoOperatorSpec } from "@/lib/mongo/mongoCompletionTables";

/**
 * What the cursor may usefully be completed with. Each mode maps to exactly one
 * item source, so `buildMongoCompletionItemsFromContext` never has to re-derive
 * position from text — `getMongoCompletionContext` already did.
 *
 * `none` means "the cursor is somewhere we have nothing useful to say" (a string
 * literal value, an argument we do not model, …). It yields an empty list, which
 * the editor turns into "no popup" — deliberately better than falling back to
 * `root` and showing unrelated `db.…` snippets mid-document.
 */
export type MongoCompletionMode = "none" | "root" | "collection" | "collectionOrMethod" | "collectionRef" | "method" | "cursorMethod" | "field" | "fieldPath" | "fieldRef" | "value" | "queryOperator" | "updateOperator" | "pushModifier" | "expression" | "accumulator" | "stage" | "stageOption";

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
  /** Collection the cursor's command targets, used to load field metadata. */
  collection?: string;
  /** Enclosing aggregation stage (`$lookup`, `$group`, …), when inside one. */
  stage?: string;
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
  { label: "count", detail: "Count matching documents (legacy helper)", apply: "count({})" },
  { label: "distinct", detail: "List the distinct values of a field", apply: 'distinct("${field}")' },
  { label: "insertOne", detail: "Insert one document", apply: "insertOne({})" },
  { label: "insertMany", detail: "Insert multiple documents", apply: "insertMany([{}])" },
  { label: "updateOne", detail: "Update one matching document", apply: "updateOne({}, { $set: {} })" },
  { label: "updateMany", detail: "Update all matching documents", apply: "updateMany({}, { $set: {} })" },
  { label: "deleteOne", detail: "Delete one matching document", apply: "deleteOne({})" },
  { label: "deleteMany", detail: "Delete all matching documents", apply: "deleteMany({})" },
  { label: "findOneAndUpdate", detail: "Atomically update and return a document", apply: "findOneAndUpdate({}, { $set: {} })" },
  { label: "findOneAndReplace", detail: "Atomically replace and return a document", apply: "findOneAndReplace({}, {})" },
  { label: "findOneAndDelete", detail: "Atomically delete and return a document", apply: "findOneAndDelete({})" },
  { label: "getIndexes", detail: "List collection indexes", apply: "getIndexes()" },
  { label: "stats", detail: "Show collection statistics", apply: "stats()" },
  { label: "dataSize", detail: "Total size of documents in bytes", apply: "dataSize()" },
  { label: "storageSize", detail: "Allocated storage size in bytes", apply: "storageSize()" },
  { label: "totalIndexSize", detail: "Total size of all indexes in bytes", apply: "totalIndexSize()" },
  { label: "createIndex", detail: "Create an index", apply: "createIndex({ ${field}: 1 })" },
  { label: "dropIndex", detail: "Drop one index", apply: 'dropIndex("${indexName}")' },
  { label: "dropIndexes", detail: "Drop collection indexes", apply: "dropIndexes()" },
  { label: "drop", detail: "Drop the collection", apply: "drop()" },
] as const;

/** Database-level helpers, offered next to the collection names after `db.`. */
const DATABASE_METHODS = [
  { label: "getCollection", detail: "Reference a collection by name", apply: 'getCollection("${collection}")' },
  { label: "version", detail: "Show the MongoDB server version", apply: "version()" },
] as const;

const CURSOR_METHODS = [
  { label: "sort", detail: "Sort cursor results", apply: "sort({ ${field}: 1 })" },
  { label: "limit", detail: "Limit cursor results", apply: "limit(100)" },
  { label: "skip", detail: "Skip cursor results", apply: "skip(0)" },
] as const;

/**
 * `find().count()` is only accepted when `count()` is the sole chained call, so
 * it is offered directly after `find(…)` and withheld once the chain has grown.
 */
const CURSOR_COUNT_METHOD = { label: "count", detail: "Count the documents matched by find()", apply: "count()" } as const;

const ROOT_SNIPPETS = [
  { label: "db.collection.find", detail: "Find documents", apply: "db.${collection}.find({})" },
  { label: "db.collection.aggregate", detail: "Aggregation pipeline", apply: "db.${collection}.aggregate([\n  { $match: {} }\n])" },
  { label: "db.getCollection", detail: "Reference a collection by name", apply: 'db.getCollection("${collection}")' },
  { label: "use", detail: "Switch the active database", apply: "use ${database}" },
  { label: "db.version", detail: "Show the MongoDB server version", apply: "db.version()" },
] as const;

/** Role of each positional argument, by collection helper. Drives cursor classification. */
type MongoArgRole = "filter" | "update" | "replacement" | "document" | "documents" | "pipeline" | "projection" | "keys" | "sortKeys" | "fieldName" | "options";

const METHOD_ARG_ROLES: Record<string, readonly MongoArgRole[]> = {
  find: ["filter", "projection", "options"],
  findOne: ["filter", "projection", "options"],
  countDocuments: ["filter", "options"],
  count: ["filter", "options"],
  deleteOne: ["filter", "options"],
  deleteMany: ["filter", "options"],
  findOneAndDelete: ["filter", "options"],
  updateOne: ["filter", "update", "options"],
  updateMany: ["filter", "update", "options"],
  findOneAndUpdate: ["filter", "update", "options"],
  findOneAndReplace: ["filter", "replacement", "options"],
  insertOne: ["document", "options"],
  insertMany: ["documents", "options"],
  aggregate: ["pipeline", "options"],
  createIndex: ["keys", "options"],
  distinct: ["fieldName", "filter"],
  sort: ["sortKeys"],
};

const CALL_METHOD_PATTERN = new RegExp(`\\.(${Object.keys(METHOD_ARG_ROLES).join("|")})\\s*\\(`, "g");

/** Stages whose body is a fixed set of option keys rather than a field map. */
const OPTION_STAGES = new Set(Object.keys(STAGE_OPTION_KEYS));

/** Stages taking a bare `"$field"` string, completed as a field reference. */
const FIELD_REF_STAGES = new Set(["$unwind", "$sortByCount", "$replaceWith"]);

/** Value position inside a stage's option object, by stage and option key. */
const STAGE_OPTION_VALUE_MODES: Record<string, Record<string, MongoCompletionMode>> = {
  $lookup: { from: "collectionRef", localField: "fieldPath", foreignField: "fieldPath" },
  $graphLookup: { from: "collectionRef", startWith: "fieldRef", connectFromField: "fieldPath", connectToField: "fieldPath" },
  $unwind: { path: "fieldRef" },
  $merge: { into: "collectionRef", on: "fieldPath" },
  $unionWith: { coll: "collectionRef" },
  $bucket: { groupBy: "fieldRef" },
  $bucketAuto: { groupBy: "fieldRef" },
  $setWindowFields: { partitionBy: "fieldRef" },
  $geoNear: { key: "fieldPath" },
  $replaceRoot: { newRoot: "fieldRef" },
};

export function getMongoCompletionContext(text: string, cursor: number): MongoCompletionContext {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const beforeCursor = text.slice(0, safeCursor);
  const collection = extractActiveCollection(text, safeCursor);
  const { prefix, from } = readPropertyPrefix(text, safeCursor);
  const at = (mode: MongoCompletionMode, stage?: string): MongoCompletionContext => ({ mode, prefix, from, collection, stage });

  if (isInsideMongoComment(text, safeCursor)) return { mode: "none", prefix: "", from: safeCursor };

  if (beforeCursor.endsWith("db.")) return { mode: "collection", prefix: "", from: safeCursor, collection };

  const getCollectionPrefix = matchGetCollectionPrefix(beforeCursor);
  if (getCollectionPrefix) return { mode: "collectionRef", prefix: getCollectionPrefix.prefix, from: getCollectionPrefix.from, collection };

  const collectionPrefix = matchDbCollectionPrefix(beforeCursor);
  if (collectionPrefix) {
    return {
      mode: collectionPrefix.prefix.includes(".") ? "collectionOrMethod" : "collection",
      prefix: collectionPrefix.prefix,
      from: collectionPrefix.from,
      collection,
    };
  }

  if (isAfterCollectionDot(beforeCursor)) {
    const methodPrefix = readMethodPrefix(beforeCursor);
    return { mode: "method", prefix: methodPrefix.prefix, from: methodPrefix.from, collection };
  }

  const cursorChain = matchCursorMethodDot(beforeCursor);
  if (cursorChain) {
    const methodPrefix = readMethodPrefix(beforeCursor);
    return { mode: "cursorMethod", prefix: methodPrefix.prefix, from: methodPrefix.from, collection, stage: cursorChain.countable ? "countable" : undefined };
  }

  const call = findInnermostMongoCall(beforeCursor);
  if (!call) return at("root");

  const scan = scanMongoCallArguments(text, call.openParenIndex + 1, safeCursor);
  if (!scan) return at("root");

  const classified = classifyCursorInCall(call.method, scan);
  return { ...at(classified.mode, classified.stage), collection: classified.collection ?? collection };
}

export function buildMongoCompletionItems(text: string, cursor: number, input: MongoCompletionInput = {}): MongoCompletionItem[] {
  return buildMongoCompletionItemsFromContext(getMongoCompletionContext(text, cursor), input);
}

export function buildMongoCompletionItemsFromContext(context: MongoCompletionContext, input: MongoCompletionInput = {}): MongoCompletionItem[] {
  const { mode, prefix } = context;
  const collections = input.collections ?? [];
  const fields = input.fields ?? [];

  switch (mode) {
    case "none":
      return [];
    case "root":
      return rootItems(prefix);
    case "collection":
      return collectionItems(prefix, collections);
    case "collectionOrMethod":
      return collectionOrMethodItems(prefix, collections);
    case "collectionRef":
      return collectionRefItems(prefix, collections);
    case "method":
      return methodItems(prefix);
    case "cursorMethod":
      return cursorMethodItems(prefix, context.stage === "countable");
    case "field":
      return fieldItems(prefix, fields);
    case "fieldPath":
      return fieldPathItems(prefix, fields);
    case "fieldRef":
      return fieldRefItems(prefix, fields);
    case "value":
      return specItems(VALUE_SNIPPETS, prefix, "value", 100);
    case "queryOperator":
      return specItems(QUERY_OPERATORS, prefix, "query operator", 100);
    case "updateOperator":
      return specItems(UPDATE_OPERATORS, prefix, "update operator", 100);
    case "pushModifier":
      return specItems(PUSH_MODIFIERS, prefix, "array update modifier", 100);
    case "expression":
      return [...specItems(EXPRESSION_OPERATORS, prefix, "aggregation expression", 100), ...fieldRefItems(prefix, fields, 80)];
    case "accumulator":
      return specItems(ACCUMULATORS, prefix, "accumulator", 100);
    case "stage":
      return specItems(PIPELINE_STAGES, prefix, "aggregation stage", 100);
    case "stageOption":
      return specItems(STAGE_OPTION_KEYS[context.stage ?? ""] ?? [], prefix, `${context.stage} option`, 100);
    default:
      return [];
  }
}

/** Modes whose items are built from the target collection's sampled fields. */
export function mongoCompletionNeedsFields(mode: MongoCompletionMode): boolean {
  return mode === "field" || mode === "fieldPath" || mode === "fieldRef" || mode === "expression";
}

/** Modes whose items are built from the database's collection names. */
export function mongoCompletionNeedsCollections(mode: MongoCompletionMode): boolean {
  return mode === "collection" || mode === "collectionOrMethod" || mode === "collectionRef";
}

export function shouldAutoOpenMongoCompletion(text: string, cursor: number): boolean {
  const previousChar = text[cursor - 1];
  if (!previousChar) return false;
  if (text.slice(0, cursor).endsWith("db.")) return true;
  if (previousChar === "$" || previousChar === "." || previousChar === '"' || previousChar === "'") return true;
  if (/[{,[:]/.test(previousChar) || /[{,[:]\s+$/.test(text.slice(0, cursor))) {
    return getMongoCompletionContext(text, cursor).mode !== "none";
  }
  if (/[\w_$-]/.test(previousChar)) return true;
  return false;
}

export function getMongoCompletionResultValidFor(): RegExp {
  return /["']?[\w_$.-]*$/;
}

export function inferMongoCompletionFields(documents: unknown[]): MongoCompletionField[] {
  const typeByPath = new Map<string, Set<string>>();
  for (const doc of documents) collectFieldTypes(doc, "", typeByPath, 0);
  return [...typeByPath.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, types]) => ({ name, type: [...types].sort().join(" | ") }));
}

/* ------------------------------------------------------------------ *
 * Cursor classification
 * ------------------------------------------------------------------ */

type MongoContainerKind = "object" | "array" | "call";

interface MongoContainer {
  kind: MongoContainerKind;
  /** Key this container is the value of, e.g. `age` in `{ age: { … } }`. */
  key: string | null;
}

interface MongoCallScan {
  /** Index of the positional argument the cursor sits in. */
  argIndex: number;
  /** Open containers between the call's `(` and the cursor, outermost first. */
  stack: MongoContainer[];
  /** Key whose value the cursor sits in, when past a `:` in the innermost object. */
  valueKey: string | null;
  inValue: boolean;
  inString: boolean;
}

interface MongoCursorClass {
  mode: MongoCompletionMode;
  stage?: string;
  collection?: string;
}

/**
 * Walks a collection helper's arguments from its `(` to the cursor, tracking the
 * open `{}`/`[]`/`()` containers and the key each one is the value of. Returns
 * null when the call closes before the cursor — i.e. the cursor is not inside it.
 *
 * Intentionally not a real parser: it only needs enough structure (which
 * container we are in, and under which key) to know what to suggest, and it must
 * keep working on the half-typed input that completion always runs against.
 */
function scanMongoCallArguments(text: string, start: number, cursor: number): MongoCallScan | null {
  const stack: MongoContainer[] = [];
  let argIndex = 0;
  let token = "";
  let valueKey: string | null = null;
  let inValue = false;
  let quote: string | null = null;

  for (let i = start; i < cursor; i++) {
    const char = text[i] ?? "";
    if (quote) {
      if (char === "\\") {
        i++;
        continue;
      }
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if ((char === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) || (char === "-" && text[i + 1] === "-")) {
      const skipped = skipMongoStringOrComment(text, i, cursor);
      if (skipped > i) {
        i = skipped - 1; // the for-loop's i++ lands us just past the comment
        token = "";
        continue;
      }
    }
    if (char === '"' || char === "'") {
      quote = char;
      token = "";
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      stack.push({ kind: char === "{" ? "object" : char === "[" ? "array" : "call", key: inValue ? valueKey : null });
      token = "";
      valueKey = null;
      inValue = false;
      continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      if (stack.length === 0) return null;
      stack.pop();
      token = "";
      valueKey = null;
      inValue = false;
      continue;
    }
    if (char === ":") {
      valueKey = token.trim() || valueKey;
      token = "";
      inValue = true;
      continue;
    }
    if (char === ",") {
      if (stack.length === 0) argIndex++;
      token = "";
      valueKey = null;
      inValue = false;
      continue;
    }
    if (!/\s/.test(char)) token += char;
  }

  return { argIndex, stack, valueKey, inValue, inString: quote !== null };
}

function classifyCursorInCall(method: string, scan: MongoCallScan): MongoCursorClass {
  const role = METHOD_ARG_ROLES[method]?.[scan.argIndex];
  if (!role) return { mode: "none" };

  switch (role) {
    case "filter":
      return { mode: classifyFilter(scan, 0) };
    case "update":
      return { mode: classifyUpdate(scan, 0) };
    case "replacement":
    case "document":
      return { mode: classifyDocument(scan, 0) };
    case "documents":
      return { mode: classifyDocument(scan, 1) };
    case "projection":
    case "keys":
    case "sortKeys":
      return { mode: classifyKeyMap(scan, 0) };
    // A bare string argument naming a field, e.g. distinct("category").
    case "fieldName":
      return { mode: scan.stack.length === 0 ? "fieldPath" : "none" };
    case "pipeline":
      return classifyPipeline(scan);
    case "options":
      return { mode: "none" };
    default:
      return { mode: "none" };
  }
}

/** Depth of the innermost container relative to the object that roots this argument. */
function innerDepth(scan: MongoCallScan, rootIndex: number): number {
  return scan.stack.length - 1 - rootIndex;
}

function innermost(scan: MongoCallScan): MongoContainer | undefined {
  return scan.stack[scan.stack.length - 1];
}

function classifyFilter(scan: MongoCallScan, rootIndex: number): MongoCompletionMode {
  const inner = innermost(scan);
  if (!inner || innerDepth(scan, rootIndex) < 0) return "none";
  if (inner.kind !== "object") return "none";
  if (scan.inValue) return scan.inString ? "none" : "value";
  if (innerDepth(scan, rootIndex) === 0) return "field";

  // Inside a nested object: whose value is it?
  switch (inner.key) {
    case null:
      return "field"; // an element of `$and` / `$or` / `$nor`
    case "$elemMatch":
      return "field";
    case "$expr":
      return "expression";
    case "$jsonSchema":
      return "none";
    default:
      return "queryOperator"; // a field's constraint object, or `$not`
  }
}

function classifyUpdate(scan: MongoCallScan, rootIndex: number): MongoCompletionMode {
  const inner = innermost(scan);
  if (!inner || innerDepth(scan, rootIndex) < 0) return "none";
  if (scan.inValue) return scan.inString ? "none" : "value";
  if (inner.kind !== "object") return "none";
  if (innerDepth(scan, rootIndex) === 0) return "updateOperator";

  const parent = scan.stack[scan.stack.length - 2];
  if (parent?.key === "$push" || parent?.key === "$addToSet") return "pushModifier";
  if (inner.key && UPDATE_OPERATOR_LABELS.has(inner.key)) return "field";
  return "field";
}

function classifyDocument(scan: MongoCallScan, rootIndex: number): MongoCompletionMode {
  const inner = innermost(scan);
  if (!inner || innerDepth(scan, rootIndex) < 0) return "none";
  if (scan.inValue) return scan.inString ? "none" : "value";
  return inner.kind === "object" ? "field" : "none";
}

function classifyKeyMap(scan: MongoCallScan, rootIndex: number): MongoCompletionMode {
  const inner = innermost(scan);
  if (!inner || scan.inValue) return "none";
  if (inner.kind !== "object" || innerDepth(scan, rootIndex) !== 0) return "none";
  return "field";
}

function classifyPipeline(scan: MongoCallScan): MongoCursorClass {
  const pipelineIndex = findPipelineArrayIndex(scan.stack);
  if (pipelineIndex < 0) return { mode: "none" };

  const stageHolder = scan.stack[pipelineIndex + 1];
  if (!stageHolder) return { mode: "none" }; // directly inside the array, no stage object yet
  if (stageHolder.kind !== "object") return { mode: "none" };

  // `[{ … }]` — the cursor is in the stage object itself.
  if (scan.stack.length - 1 === pipelineIndex + 1) {
    if (!scan.inValue) return { mode: "stage" };
    const stage = scan.valueKey ?? "";
    return { mode: stageStringValueMode(stage), stage };
  }

  const stage = scan.stack[pipelineIndex + 2]?.key ?? "";
  return classifyStageBody(stage, scan, pipelineIndex + 2);
}

/**
 * The deepest array that holds pipeline stages: the `aggregate()` argument
 * itself, a `pipeline:` option (`$lookup`, `$unionWith`), or a `$facet` branch.
 * Anything else (`$in: [ … ]`, `$and: [ … ]`) is a value array, not a pipeline.
 */
function findPipelineArrayIndex(stack: MongoContainer[]): number {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]?.kind !== "array") continue;
    if (i === 0) return i;
    if (stack[i]?.key === "pipeline") return i;
    if (stack[i - 1]?.key === "$facet") return i;
  }
  return -1;
}

function stageStringValueMode(stage: string): MongoCompletionMode {
  if (FIELD_REF_STAGES.has(stage)) return "fieldRef";
  if (stage === "$out") return "collectionRef";
  if (stage === "$unset") return "fieldPath";
  return "none";
}

function classifyStageBody(stage: string, scan: MongoCallScan, bodyIndex: number): MongoCursorClass {
  if (stage === "$match") return { mode: classifyFilter(scan, bodyIndex), stage };
  if (stage === "$group") return { mode: classifyGroup(scan, bodyIndex), stage };
  if (stage === "$sort") return { mode: classifyKeyMap(scan, bodyIndex), stage };
  if (stage === "$unset") return { mode: innermost(scan)?.kind === "array" ? "fieldPath" : "none", stage };
  if (OPTION_STAGES.has(stage)) return classifyStageOptions(stage, scan, bodyIndex);
  // `$project`-shaped stages and anything unmodelled: keys are field names, values are expressions.
  return { mode: classifyProjection(scan, bodyIndex), stage };
}

function classifyGroup(scan: MongoCallScan, bodyIndex: number): MongoCompletionMode {
  const depth = innerDepth(scan, bodyIndex);
  if (depth < 0) return "none";

  if (depth === 0) {
    // `{ $group: { _id: … , total: … } }` — keys are output names, `_id` is required.
    if (!scan.inValue) return "field";
    return scan.valueKey === "_id" ? "fieldRef" : "none";
  }

  if (scan.inValue) return "fieldRef";

  const inner = innermost(scan);
  if (inner?.kind !== "object") return "none";
  // One level in: `_id: { … }` builds a compound key, anything else is an accumulator.
  if (depth === 1) return inner.key === "_id" ? "expression" : "accumulator";
  return "expression";
}

function classifyProjection(scan: MongoCallScan, bodyIndex: number): MongoCompletionMode {
  const depth = innerDepth(scan, bodyIndex);
  if (depth < 0) return "none";
  if (scan.inValue) return "fieldRef";

  const inner = innermost(scan);
  if (inner?.kind !== "object") return "none";
  return depth === 0 ? "field" : "expression";
}

function classifyStageOptions(stage: string, scan: MongoCallScan, bodyIndex: number): MongoCursorClass {
  const depth = innerDepth(scan, bodyIndex);
  if (depth < 0) return { mode: "none", stage };

  if (depth === 0) {
    if (scan.inValue) return { mode: STAGE_OPTION_VALUE_MODES[stage]?.[scan.valueKey ?? ""] ?? "none", stage };
    return { mode: innermost(scan)?.kind === "object" ? "stageOption" : "none", stage };
  }

  if (scan.inValue) return { mode: "fieldRef", stage };
  return { mode: innermost(scan)?.kind === "object" ? "expression" : "none", stage };
}

/* ------------------------------------------------------------------ *
 * Item builders
 * ------------------------------------------------------------------ */

function rootItems(prefix: string): MongoCompletionItem[] {
  const snippets = ROOT_SNIPPETS.filter((snippet) => matchesFuzzyPrefix(snippet.label, prefix)).map((snippet) => ({
    label: snippet.label,
    type: "snippet" as const,
    detail: snippet.detail,
    apply: snippet.apply,
    boost: 120,
  }));
  const methods = COLLECTION_METHODS.filter((method) => matchesFuzzyPrefix(method.label, prefix)).map((method) => ({
    label: method.label,
    type: "function" as const,
    detail: method.detail,
    apply: method.apply,
    boost: 100,
  }));
  return dedupeAndSort([...snippets, ...methods]);
}

function collectionItems(prefix: string, collections: string[]): MongoCompletionItem[] {
  const names = collectionNameItems(prefix, collections);
  const methods = DATABASE_METHODS.filter((method) => matchesFuzzyPrefix(method.label, prefix)).map((method) => ({
    label: method.label,
    type: "function" as const,
    detail: method.detail,
    apply: method.apply,
    boost: startsWithPrefix(method.label, prefix) ? 110 : 80,
  }));
  return [...names, ...methods];
}

function collectionNameItems(prefix: string, collections: string[], boost = 120): MongoCompletionItem[] {
  return collections
    .filter((collection) => matchesFuzzyPrefix(collection, prefix))
    .slice(0, 100)
    .map((collection) => ({
      label: collection,
      type: "table" as const,
      detail: "collection",
      apply: needsGetCollectionSyntax(collection) ? `getCollection("${escapeDoubleQuoted(collection)}")` : collection,
      boost: startsWithPrefix(collection, prefix) ? boost : boost - 30,
    }));
}

function collectionOrMethodItems(prefix: string, collections: string[]): MongoCompletionItem[] {
  const dot = prefix.lastIndexOf(".");
  const collection = prefix.slice(0, dot);
  const methodPrefix = prefix.slice(dot + 1);
  const collectionRef = needsGetCollectionSyntax(collection) && collections.includes(collection) ? `getCollection("${escapeDoubleQuoted(collection)}")` : collection;
  const methods = methodItems(methodPrefix).map((item) => ({
    ...item,
    apply: `${collectionRef}.${item.apply}`,
    boost: Math.min(item.boost, 110),
  }));

  return dedupeAndSort([...collectionNameItems(prefix, collections, 150), ...methods]);
}

function collectionRefItems(prefix: string, collections: string[]): MongoCompletionItem[] {
  return collections
    .filter((collection) => matchesFuzzyPrefix(collection, prefix))
    .slice(0, 100)
    .map((collection) => ({
      label: collection,
      type: "table" as const,
      detail: "collection",
      apply: quoteMongoString(collection, prefix),
      boost: startsWithPrefix(collection, prefix) ? 120 : 90,
    }));
}

function methodItems(prefix: string): MongoCompletionItem[] {
  return dedupeAndSort(
    COLLECTION_METHODS.filter((method) => matchesFuzzyPrefix(method.label, prefix)).map((method) => ({
      label: method.label,
      type: "function" as const,
      detail: method.detail,
      apply: method.apply,
      boost: method.label === "find" || method.label === "aggregate" ? 130 : 100,
    })),
  );
}

function cursorMethodItems(prefix: string, countable: boolean): MongoCompletionItem[] {
  const methods = countable ? [...CURSOR_METHODS, CURSOR_COUNT_METHOD] : [...CURSOR_METHODS];
  return dedupeAndSort(
    methods
      .filter((method) => matchesFuzzyPrefix(method.label, prefix))
      .map((method) => ({
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
  return dedupeAndSort(
    fields
      .filter((field) => matchesFuzzyPrefix(field.name, normalizedPrefix))
      .slice(0, 100)
      .map((field) => ({
        label: field.name,
        type: "column" as const,
        detail: describeField(field, "observed field"),
        apply: `${quoteMongoFieldName(field.name, prefix)}: `,
        boost: startsWithPrefix(field.name, normalizedPrefix) ? 120 : 85,
      })),
  );
}

function fieldPathItems(prefix: string, fields: MongoCompletionField[]): MongoCompletionItem[] {
  const normalizedPrefix = normalizeMongoKeyPrefix(prefix);
  return dedupeAndSort(
    fields
      .filter((field) => matchesFuzzyPrefix(field.name, normalizedPrefix))
      .slice(0, 100)
      .map((field) => ({
        label: field.name,
        type: "column" as const,
        detail: describeField(field, "observed field"),
        apply: quoteMongoString(field.name, prefix),
        boost: startsWithPrefix(field.name, normalizedPrefix) ? 120 : 85,
      })),
  );
}

function fieldRefItems(prefix: string, fields: MongoCompletionField[], baseBoost = 100): MongoCompletionItem[] {
  const normalizedPrefix = normalizeFieldRefPrefix(prefix);
  return dedupeAndSort(
    fields
      .filter((field) => matchesFuzzyPrefix(field.name, normalizedPrefix))
      .slice(0, 100)
      .map((field) => ({
        label: `$${field.name}`,
        type: "column" as const,
        detail: describeField(field, "field reference"),
        apply: quoteMongoString(`$${field.name}`, prefix),
        boost: startsWithPrefix(field.name, normalizedPrefix) ? baseBoost + 20 : baseBoost - 15,
      })),
  );
}

function specItems(specs: readonly MongoOperatorSpec[], prefix: string, category: string, baseBoost: number): MongoCompletionItem[] {
  const normalizedPrefix = normalizeMongoKeyPrefix(prefix);
  return dedupeAndSort(
    specs
      .filter((spec) => matchesFuzzyPrefix(spec.label, normalizedPrefix))
      .map((spec) => ({
        label: spec.label,
        type: mongoOperatorItemType(spec.apply),
        detail: spec.detail,
        info: category,
        apply: spec.apply,
        boost: baseBoost + (startsWithPrefix(spec.label, normalizedPrefix) ? 20 : 0) + (COMMON_OPERATORS.has(spec.label) ? 10 : 0),
      })),
  );
}

function describeField(field: MongoCompletionField, label: string): string {
  return field.type ? `${label} · ${field.type}` : label;
}

/* ------------------------------------------------------------------ *
 * Text helpers
 * ------------------------------------------------------------------ */

function readPropertyPrefix(text: string, cursor: number): { prefix: string; from: number } {
  let from = cursor;
  while (from > 0 && /[\w_$.-]/.test(text[from - 1] ?? "")) from--;
  if (text[from - 1] === '"' || text[from - 1] === "'") from--;
  return { prefix: text.slice(from, cursor), from };
}

function readMethodPrefix(beforeCursor: string): { prefix: string; from: number } {
  const dot = beforeCursor.lastIndexOf(".");
  const from = dot >= 0 ? dot + 1 : beforeCursor.length;
  return { prefix: beforeCursor.slice(from), from };
}

function matchDbCollectionPrefix(beforeCursor: string): { prefix: string; from: number } | null {
  const match = /(?:^|[\s;(])db\.([A-Za-z_][\w$-]*(?:\.[\w$-]*)*)$/.exec(beforeCursor);
  if (!match) return null;
  const prefix = match[1] ?? "";
  return { prefix, from: beforeCursor.length - prefix.length };
}

function matchGetCollectionPrefix(beforeCursor: string): { prefix: string; from: number } | null {
  const match = /(?:^|[\s;(])db\.getCollection\(\s*(["'][^"'\\]*)$/.exec(beforeCursor);
  if (!match) return null;
  const prefix = match[1] ?? "";
  return { prefix, from: beforeCursor.length - prefix.length };
}

function isAfterCollectionDot(beforeCursor: string): boolean {
  return /(?:^|[\s;(])db\.(?:[A-Za-z_][\w$-]*|getCollection\(["'][^"']+["']\))\.[\w$-]*$/.test(beforeCursor);
}

/**
 * `db.x.find(…).…` — and whether `count()` is still legal there, which it only
 * is while no other cursor method has been chained on.
 */
function matchCursorMethodDot(beforeCursor: string): { countable: boolean } | null {
  const collectionCall = /(?:^|[\s;(])db\.(?:[A-Za-z_][\w$-]*|getCollection\(["'][^"']+["']\))\.(find|aggregate)\s*\(/g;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = collectionCall.exec(beforeCursor))) lastMatch = match;
  if (!lastMatch) return null;

  const openParen = beforeCursor.indexOf("(", lastMatch.index + lastMatch[0].length - 1);
  const closeParen = findMatchingParen(beforeCursor, openParen);
  if (closeParen < 0) return null;

  const chain = beforeCursor.slice(closeParen + 1);
  if (!/^(?:\s*\.\s*(?:sort|skip|limit)\s*\([^()]*\))*\s*\.\s*[\w$-]*$/.test(chain)) return null;
  return { countable: lastMatch[1] === "find" && /^\s*\.\s*[\w$-]*$/.test(chain) };
}

function findMatchingParen(text: string, openIndex: number): number {
  if (openIndex < 0 || text[openIndex] !== "(") return -1;
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return i;
  }
  return -1;
}

/**
 * If `text[i]` opens a string or comment, return the index just past its close
 * (clamped to `end`); otherwise return `i` unchanged. This is the single source
 * of truth for "what is a literal" — both the call locator and the argument
 * scanner defer to it so a method name, brace, or comma inside a string or
 * comment can never be mistaken for code.
 */
function skipMongoStringOrComment(text: string, i: number, end: number): number {
  const char = text[i];
  if (char === '"' || char === "'") {
    for (let j = i + 1; j < end; j++) {
      if (text[j] === "\\") {
        j++;
        continue;
      }
      if (text[j] === char) return j + 1;
    }
    return end; // an unterminated string runs to the cursor
  }
  // The editor hosts Mongo in its SQL language mode, so `--` is a line comment
  // just like the shell's own `//`; both are recognised everywhere.
  if ((char === "/" && text[i + 1] === "/") || (char === "-" && text[i + 1] === "-")) {
    const newline = text.indexOf("\n", i + 2);
    return newline < 0 || newline >= end ? end : newline; // the newline itself is code again
  }
  if (char === "/" && text[i + 1] === "*") {
    const close = text.indexOf("*/", i + 2);
    return close < 0 || close + 2 > end ? end : close + 2;
  }
  return i;
}

/** Blank out string/comment CONTENT (preserving length, so offsets stay valid) before pattern matching. */
function maskMongoLiterals(text: string): string {
  const chars = [...text];
  let i = 0;
  while (i < chars.length) {
    const skipped = skipMongoStringOrComment(text, i, text.length);
    if (skipped > i) {
      for (let j = i; j < skipped; j++) {
        if (chars[j] !== "\n") chars[j] = " ";
      }
      i = skipped;
    } else {
      i++;
    }
  }
  return chars.join("");
}

function findInnermostMongoCall(beforeCursor: string): { method: string; openParenIndex: number } | null {
  // Match over masked text so `.aggregate(` inside a string value or comment is
  // not seen as a call; offsets are preserved so openParenIndex stays valid.
  const masked = maskMongoLiterals(beforeCursor);
  CALL_METHOD_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  let result: { method: string; openParenIndex: number } | null = null;
  while ((match = CALL_METHOD_PATTERN.exec(masked))) {
    const method = match[1];
    if (method) result = { method, openParenIndex: match.index + match[0].lastIndexOf("(") };
  }
  return result;
}

/**
 * Whether the cursor sits inside a `//` or `/* … *\/` comment. Walks from the
 * start with the shared literal rules so a `/*` inside a string is not a comment
 * and a `//` inside a string is not either; an unterminated comment runs to the
 * cursor, so `db.users.find({ /* na` correctly suppresses completion.
 */
function isInsideMongoComment(text: string, cursor: number): boolean {
  let i = 0;
  while (i < cursor) {
    const char = text[i];
    if (char === '"' || char === "'") {
      i = skipMongoStringOrComment(text, i, text.length);
      continue;
    }
    if ((char === "/" && text[i + 1] === "/") || (char === "-" && text[i + 1] === "-")) {
      const newline = text.indexOf("\n", i + 2);
      const end = newline < 0 ? text.length : newline;
      if (cursor <= end) return true;
      i = end;
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close < 0 || cursor <= close + 1) return true;
      i = close + 2;
      continue;
    }
    i++;
  }
  return false;
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
  if (prefix.startsWith("'")) return `'${escapeSingleQuoted(field)}'`;
  return field;
}

/** Always quotes: these completions land in value position, where a bare word is invalid. */
function quoteMongoString(value: string, prefix: string): string {
  if (prefix.startsWith("'")) return `'${escapeSingleQuoted(value)}'`;
  return `"${escapeDoubleQuoted(value)}"`;
}

function normalizeMongoKeyPrefix(prefix: string): string {
  return prefix.replace(/^["']/, "");
}

function normalizeFieldRefPrefix(prefix: string): string {
  return normalizeMongoKeyPrefix(prefix).replace(/^\$/, "");
}

function needsGetCollectionSyntax(collection: string): boolean {
  return !/^[A-Za-z_][\w$]*$/.test(collection);
}

function escapeDoubleQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeSingleQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function startsWithPrefix(value: string, prefix: string): boolean {
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

function matchesFuzzyPrefix(value: string, prefix: string): boolean {
  const normalizedPrefix = normalizeMongoKeyPrefix(prefix).toLowerCase();
  if (!normalizedPrefix) return true;
  return value.toLowerCase().includes(normalizedPrefix);
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
