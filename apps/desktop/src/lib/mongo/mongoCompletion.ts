import { mongoExtendedJsonValueType } from "@/lib/mongo/mongoDocumentValues";
import {
  ACCUMULATORS,
  COMMON_OPERATORS,
  EXPRESSION_OPERATORS,
  ENUM_VALUES,
  EXTENDED_JSON_VALUES,
  FIELD_QUERY_OPERATORS,
  PIPELINE_STAGES,
  PUSH_MODIFIERS,
  BULK_WRITE_OPERATION_FIELDS,
  BULK_WRITE_OPERATIONS,
  KEY_MAP_VALUES,
  METHOD_OPTION_KEYS,
  OPERATOR_SUB_KEYS,
  STAGE_OPTION_KEYS,
  TOP_LEVEL_QUERY_OPERATORS,
  UPDATE_OPERATORS,
  VALUE_SNIPPETS,
  WINDOW_FUNCTION_OPERATORS,
  mongoOperatorItemType,
  type MongoOperatorSpec,
} from "@/lib/mongo/mongoCompletionTables";

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
export type MongoCompletionMode =
  | "none"
  | "root"
  | "database"
  | "collection"
  | "collectionOrMethod"
  | "collectionRef"
  | "method"
  | "cursorMethod"
  | "field"
  | "filterField"
  | "pullCondition"
  | "fieldPath"
  | "fieldRef"
  | "value"
  | "valueWrapper"
  | "queryOperator"
  | "updateOperator"
  | "pushModifier"
  | "expression"
  | "accumulator"
  | "windowOperator"
  | "stage"
  | "stageOption"
  | "methodOption"
  | "bulkWriteOperation"
  | "bulkWriteField"
  | "keyMapValue"
  | "operatorField"
  | "enumValue";

/** Kind of aggregation or update pipeline holding the cursor. */
export type MongoPipelineKind = "aggregate" | "update" | "facet" | "join" | "view";

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
  filterText?: string;
  replaceClosingQuote?: '"' | "'";
  boost: number;
}

export interface MongoCompletionContext {
  mode: MongoCompletionMode;
  prefix: string;
  from: number;
  /** The selected collection name should consume the existing closing quote. */
  replaceClosingQuote?: '"' | "'";
  /** Collection the cursor's command targets, used to load field metadata. */
  collection?: string;
  /** Database the cursor's command targets when reached through `db.getSiblingDB(…)` or `use <db>`, used instead of the editor's active database. */
  database?: string;
  /** Whether the command's root is an explicit `db.getSiblingDB(…)`, which disallows chaining another getSiblingDB. */
  siblingRoot?: boolean;
  /** Enclosing aggregation stage (`$lookup`, `$group`, …), when inside one. */
  stage?: string;
  /** Kind of pipeline array holding the cursor, when inside a pipeline. */
  pipelineKind?: MongoPipelineKind;
  /** Collection method whose options object the cursor sits in. */
  method?: string;
  /** bulkWrite operation (`updateOne`, `deleteMany`, …) whose body the cursor sits in. */
  bulkWriteOperation?: string;
  /** Which field-to-value map the cursor sits in: `sort`, `projection` or `index`. */
  keyMap?: string;
  /** Operator whose own sub-document the cursor sits in (`$text`, `$near`, `$jsonSchema`, `collation`). */
  operator?: string;
  /** Which fixed value set the cursor's value position accepts (`$type`, `explain`, `caseFirst`). */
  enumKey?: string;
}

export interface MongoCompletionInput {
  databases?: string[];
  collections?: string[];
  fields?: MongoCompletionField[];
}

const COLLECTION_METHODS = [
  { label: "find", detail: "Query matching documents", apply: "find({})" },
  { label: "findOne", detail: "Query one matching document", apply: "findOne({})" },
  { label: "aggregate", detail: "Run an aggregation pipeline", apply: "aggregate([])" },
  { label: "countDocuments", detail: "Count matching documents", apply: "countDocuments({})" },
  { label: "count", detail: "Count matching documents (legacy helper)", apply: "count({})" },
  { label: "estimatedDocumentCount", detail: "Estimate the document count from collection metadata", apply: "estimatedDocumentCount()" },
  { label: "distinct", detail: "List the distinct values of a field", apply: 'distinct("${field}")' },
  { label: "insertOne", detail: "Insert one document", apply: "insertOne({})" },
  { label: "insertMany", detail: "Insert multiple documents", apply: "insertMany([{}])" },
  { label: "updateOne", detail: "Update one matching document", apply: "updateOne({}, { $set: {} })" },
  { label: "updateMany", detail: "Update all matching documents", apply: "updateMany({}, { $set: {} })" },
  { label: "replaceOne", detail: "Replace one matching document", apply: "replaceOne({}, {})" },
  { label: "bulkWrite", detail: "Run several writes in one batch", apply: "bulkWrite([\n  { insertOne: { document: {} } }\n])" },
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
  { label: "renameCollection", detail: "Rename the collection", apply: 'renameCollection("${newName}")' },
  { label: "drop", detail: "Drop the collection", apply: "drop()" },
] as const;

const COLLECTION_METHOD_BOOST: Record<(typeof COLLECTION_METHODS)[number]["label"], number> = {
  find: 240,
  findOne: 230,
  aggregate: 220,
  countDocuments: 210,
  estimatedDocumentCount: 205,
  distinct: 200,
  insertOne: 180,
  insertMany: 170,
  updateOne: 160,
  updateMany: 150,
  replaceOne: 145,
  bulkWrite: 135,
  deleteOne: 140,
  deleteMany: 130,
  findOneAndUpdate: 120,
  findOneAndReplace: 115,
  findOneAndDelete: 110,
  getIndexes: 100,
  stats: 95,
  createIndex: 90,
  count: 80,
  dataSize: 75,
  storageSize: 70,
  totalIndexSize: 65,
  renameCollection: 55,
  dropIndex: 50,
  dropIndexes: 45,
  drop: 30,
};

/** Database-level helpers, offered next to the collection names after `db.`. */
const DATABASE_METHODS = [
  { label: "getCollection", detail: "Reference a collection by name", apply: 'getCollection("${}")' },
  { label: "version", detail: "Show the MongoDB server version", apply: "version()" },
  { label: "getSiblingDB", detail: "Run the next command against another database", apply: 'getSiblingDB("${database}")' },
  { label: "runCommand", detail: "Run a database command document", apply: "runCommand({ ${} })" },
  { label: "stats", detail: "Show database statistics", apply: "stats()" },
  { label: "serverStatus", detail: "Show server status", apply: "serverStatus()" },
  { label: "createCollection", detail: "Create a collection", apply: 'createCollection("${name}")' },
  { label: "dropDatabase", detail: "Drop the current database", apply: "dropDatabase()" },
] as const;

const CURSOR_METHODS = [
  { label: "sort", detail: "Sort cursor results", apply: "sort({ ${field}: 1 })" },
  { label: "limit", detail: "Limit cursor results", apply: "limit(100)" },
  { label: "skip", detail: "Skip cursor results", apply: "skip(0)" },
  { label: "explain", detail: "Show the query plan instead of the results", apply: 'explain("executionStats")' },
  { label: "collation", detail: "Locale-aware rules for matching and sorting", apply: 'collation({ locale: "${en}" })' },
] as const;

/**
 * `find().count()` is only accepted when `count()` is the sole chained call, so
 * it is offered directly after `find(…)` and withheld once the chain has grown.
 */
const CURSOR_COUNT_METHOD = { label: "count", detail: "Count the documents matched by find()", apply: "count()" } as const;

/**
 * Cursor methods that change nothing: results are always materialised, so DBX
 * drops these calls at execution time. Accepted after both find() and aggregate().
 */
const NOOP_CURSOR_METHODS = [
  { label: "toArray", detail: "Materialise cursor results into an array", apply: "toArray()" },
  { label: "pretty", detail: "Format results for display", apply: "pretty()" },
] as const;

const ROOT_SNIPPETS = [
  { label: "db.collection.find", detail: "Find documents", apply: "db.${collection}.find({})" },
  { label: "db.collection.aggregate", detail: "Aggregation pipeline", apply: "db.${collection}.aggregate([\n  { $match: {} }\n])" },
  { label: "db.getCollection", detail: "Reference a collection by name", apply: 'db.getCollection("${}")' },
  { label: "use", detail: "Switch the active database", apply: "use ${database}" },
  { label: "db.version", detail: "Show the MongoDB server version", apply: "db.version()" },
  { label: "db.stats", detail: "Show database statistics", apply: "db.stats()" },
  { label: "db.serverStatus", detail: "Show server status", apply: "db.serverStatus()" },
] as const;

const ROOT_SNIPPET_BOOST: Record<(typeof ROOT_SNIPPETS)[number]["label"], number> = {
  "db.collection.find": 350,
  "db.collection.aggregate": 340,
  "db.getCollection": 330,
  use: 320,
  "db.version": 310,
  "db.stats": 305,
  "db.serverStatus": 300,
};

/** Role of each positional argument, by collection helper. Drives cursor classification. */
type MongoArgRole = "filter" | "update" | "replacement" | "document" | "documents" | "operations" | "pipeline" | "projection" | "keys" | "sortKeys" | "fieldName" | "options" | "collation" | "verbosity" | "name";

const METHOD_ARG_ROLES: Record<string, readonly MongoArgRole[]> = {
  find: ["filter", "projection"],
  findOne: ["filter", "projection", "options"],
  countDocuments: ["filter"],
  count: ["filter"],
  deleteOne: ["filter"],
  deleteMany: ["filter"],
  findOneAndDelete: ["filter", "options"],
  updateOne: ["filter", "update", "options"],
  updateMany: ["filter", "update", "options"],
  replaceOne: ["filter", "replacement", "options"],
  bulkWrite: ["operations", "options"],
  findOneAndUpdate: ["filter", "update", "options"],
  findOneAndReplace: ["filter", "replacement", "options"],
  insertOne: ["document"],
  insertMany: ["documents"],
  aggregate: ["pipeline", "options"],
  createIndex: ["keys", "options"],
  distinct: ["fieldName", "filter"],
  sort: ["sortKeys"],
  collation: ["collation"],
  explain: ["verbosity"],
  // Database-level helpers whose argument is a document.
  createCollection: ["name", "options"],
  runCommand: ["options"],
};

/** `{ $oid: "..." }` for a bare value position, where the user has not typed the braces yet. */
const BRACED_EXTENDED_JSON_VALUES: MongoOperatorSpec[] = EXTENDED_JSON_VALUES.map((spec) => ({ ...spec, apply: `{ ${spec.apply} }` }));

/** Query operators whose array holds plain values, unlike `$and` / `$or` / `$nor` which hold sub-filters. */
const VALUE_ARRAY_OPERATORS = new Set(["$in", "$nin", "$all"]);

const CALL_METHOD_PATTERN = new RegExp(`\\.(${Object.keys(METHOD_ARG_ROLES).join("|")})\\s*\\(`, "g");

/** Modes reached by walking the `db.collection.method` chain, where a `.` switches item source. */
const DOT_SCOPED_MODES = new Set<MongoCompletionMode>(["root", "collection", "collectionOrMethod", "method", "cursorMethod"]);

/** Stages whose body is a fixed set of option keys rather than a field map. */
const OPTION_STAGES = new Set(Object.keys(STAGE_OPTION_KEYS));

/** The stages an update pipeline accepts: those that rewrite the document without reshaping the result set. */
const UPDATE_PIPELINE_STAGES = PIPELINE_STAGES.filter((stage) => ["$set", "$addFields", "$unset", "$project", "$replaceRoot", "$replaceWith"].includes(stage.label));

/** Stages that write or merge results, illegal inside sub-pipelines and view definitions. */
const SUB_PIPELINE_FORBIDDEN_STAGES = new Set(["$out", "$merge"]);

/** Stages MongoDB rejects inside a $facet branch: writes, nesting, metadata/source stages, and $geoNear. */
const FACET_FORBIDDEN_STAGES = new Set(["$out", "$merge", "$facet", "$collStats", "$indexStats", "$planCacheStats", "$geoNear", "$documents", "$changeStream"]);

/** Stages accepted in join sub-pipelines ($lookup, $unionWith) and view definitions. */
const SUB_PIPELINE_STAGES = PIPELINE_STAGES.filter((stage) => !SUB_PIPELINE_FORBIDDEN_STAGES.has(stage.label));

/** Stages accepted inside a $facet branch. */
const FACET_PIPELINE_STAGES = PIPELINE_STAGES.filter((stage) => !FACET_FORBIDDEN_STAGES.has(stage.label));

function pipelineStagesFor(kind?: MongoPipelineKind): MongoOperatorSpec[] {
  switch (kind) {
    case "update":
      return UPDATE_PIPELINE_STAGES;
    case "facet":
      return FACET_PIPELINE_STAGES;
    case "join":
    case "view":
      return SUB_PIPELINE_STAGES;
    default:
      return PIPELINE_STAGES;
  }
}

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
  $densify: { field: "fieldPath" },
  $fill: { partitionBy: "fieldRef" },
};

export function getMongoCompletionContext(text: string, cursor: number): MongoCompletionContext {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const beforeCursor = text.slice(0, safeCursor);
  const collection = extractActiveCollection(text, safeCursor);
  const database = extractActiveDatabase(text, safeCursor);
  const { prefix, from } = readMongoPropertyPrefix(text, safeCursor);
  const replaceClosingQuote = closingQuoteAtCursor(prefix, text, safeCursor);
  const at = (mode: MongoCompletionMode, stage?: string, method?: string, bulkWriteOperation?: string, keyMap?: string): MongoCompletionContext => ({ mode, prefix, from, replaceClosingQuote, collection, database, stage, method, bulkWriteOperation, keyMap });

  if (isInsideMongoComment(text, safeCursor)) return { mode: "none", prefix: "", from: safeCursor };

  const usePrefix = matchUseDatabasePrefix(beforeCursor);
  if (usePrefix) return { mode: "database", prefix: usePrefix.prefix, from: usePrefix.from };

  if (endsAtDbRootDot(beforeCursor)) {
    return {
      mode: "collection",
      prefix: "",
      from: safeCursor,
      collection,
      database,
      siblingRoot: endsAtSiblingRootDot(beforeCursor),
    };
  }

  const getSiblingDbPrefix = matchGetSiblingDbPrefix(beforeCursor);
  if (getSiblingDbPrefix) {
    return {
      mode: "database",
      prefix: getSiblingDbPrefix.prefix,
      from: getSiblingDbPrefix.from,
      replaceClosingQuote: closingQuoteAtCursor(getSiblingDbPrefix.prefix, text, safeCursor),
    };
  }

  const getCollectionPrefix = matchGetCollectionPrefix(beforeCursor);
  if (getCollectionPrefix) {
    return {
      mode: "collectionRef",
      prefix: getCollectionPrefix.prefix,
      from: getCollectionPrefix.from,
      replaceClosingQuote: closingQuoteAtCursor(getCollectionPrefix.prefix, text, safeCursor),
      collection,
      database,
    };
  }

  const collectionPrefix = matchDbCollectionPrefix(beforeCursor);
  if (collectionPrefix) {
    const isSibling = matchSiblingCollectionPrefix(beforeCursor);
    return {
      mode: collectionPrefix.prefix.includes(".") ? "collectionOrMethod" : "collection",
      prefix: collectionPrefix.prefix,
      from: collectionPrefix.from,
      collection,
      database,
      ...(isSibling ? { siblingRoot: true } : {}),
    };
  }

  if (isAfterCollectionDot(beforeCursor)) {
    const methodPrefix = readMethodPrefix(beforeCursor);
    return { mode: "method", prefix: methodPrefix.prefix, from: methodPrefix.from, collection, database };
  }

  const cursorChain = matchCursorMethodDot(beforeCursor);
  if (cursorChain) {
    if (cursorChain.terminal) return at("none");
    const methodPrefix = readMethodPrefix(beforeCursor);
    return { mode: "cursorMethod", prefix: methodPrefix.prefix, from: methodPrefix.from, collection, database, stage: cursorChain.countable ? "countable" : cursorChain.find ? "find" : undefined };
  }

  const call = findInnermostMongoCall(beforeCursor);
  // Top-level snippets belong at the start of a command. Inside an argument list — of a method
  // this engine does not model (`limit(`, `drop(`, `dropIndex("`, `runCommand({`, …) or after a
  // `use` — they are noise: `db.collection.find` is not something you can type there.
  if (!call) return isInsideCallArguments(beforeCursor) || isAfterUseKeyword(beforeCursor) ? at("none") : at("root");

  const scan = scanMongoCallArguments(text, call.openParenIndex + 1, safeCursor);
  if (!scan) return isInsideCallArguments(beforeCursor) || isAfterUseKeyword(beforeCursor) ? at("none") : at("root");

  const classified = classifyCursorInCall(call.method, scan);
  return {
    ...at(classified.mode, classified.stage, classified.method, classified.bulkWriteOperation, classified.keyMap),
    ...(classified.operator ? { operator: classified.operator } : {}),
    ...(classified.enumKey ? { enumKey: classified.enumKey } : {}),
    ...(classified.pipelineKind ? { pipelineKind: classified.pipelineKind } : {}),
    collection: classified.collection ?? collection,
  };
}

export function buildMongoCompletionItems(text: string, cursor: number, input: MongoCompletionInput = {}): MongoCompletionItem[] {
  return buildMongoCompletionItemsFromContext(getMongoCompletionContext(text, cursor), input);
}

export function buildMongoCompletionItemsFromContext(context: MongoCompletionContext, input: MongoCompletionInput = {}): MongoCompletionItem[] {
  const { mode, prefix } = context;
  const collections = input.collections ?? [];
  const fields = input.fields ?? [];

  let items: MongoCompletionItem[];
  switch (mode) {
    case "none":
      items = [];
      break;
    case "root":
      items = rootItems(prefix);
      break;
    case "database":
      items = databaseItems(prefix, input.databases ?? []);
      break;
    case "collection":
      items = collectionItems(prefix, collections, context.siblingRoot ?? false);
      break;
    case "collectionOrMethod":
      items = collectionOrMethodItems(prefix, collections);
      break;
    case "collectionRef":
      items = collectionRefItems(prefix, collections);
      break;
    case "method":
      items = methodItems(prefix);
      break;
    case "cursorMethod":
      items = cursorMethodItems(prefix, context.stage === "countable", context.stage === "countable" || context.stage === "find");
      break;
    case "field":
      items = fieldItems(prefix, fields);
      break;
    case "filterField":
      // Fields lead; `$and` / `$or` and the other whole-filter operators follow once `$` is typed.
      items = [...fieldItems(prefix, fields), ...specItems(TOP_LEVEL_QUERY_OPERATORS, prefix, "query operator", 80)];
      break;
    case "pullCondition":
      // Fields lead; query operators follow once `$` is typed.
      items = [...fieldItems(prefix, fields), ...specItems(FIELD_QUERY_OPERATORS, prefix, "query operator", 80)];
      break;
    case "fieldPath":
      items = fieldPathItems(prefix, fields);
      break;
    case "fieldRef":
      items = fieldRefItems(prefix, fields);
      break;
    case "value":
      // Shell constructors first; the extended JSON spellings need their own braces here.
      items = [...specItems(VALUE_SNIPPETS, prefix, "value", 100), ...specItems(BRACED_EXTENDED_JSON_VALUES, prefix, "extended JSON value", 90)];
      break;
    case "valueWrapper":
      items = specItems(EXTENDED_JSON_VALUES, prefix, "extended JSON value", 100);
      break;
    case "queryOperator":
      // `{ _id: { $oid: ... } }` is as valid here as `{ _id: { $gt: ... } }`.
      items = [...specItems(FIELD_QUERY_OPERATORS, prefix, "query operator", 100), ...specItems(EXTENDED_JSON_VALUES, prefix, "extended JSON value", 90)];
      break;
    case "updateOperator":
      items = specItems(UPDATE_OPERATORS, prefix, "update operator", 100);
      break;
    case "pushModifier":
      items = specItems(PUSH_MODIFIERS, prefix, "array update modifier", 100);
      break;
    case "expression":
      items = [...specItems(EXPRESSION_OPERATORS, prefix, "aggregation expression", 100), ...fieldRefItems(prefix, fields, 80)];
      break;
    case "accumulator":
      items = specItems(ACCUMULATORS, prefix, "accumulator", 100);
      break;
    case "windowOperator":
      items = specItems(WINDOW_FUNCTION_OPERATORS, prefix, "window operator", 100);
      break;
    case "stage": {
      const kind = context.pipelineKind;
      const detail = kind === "update" ? "update stage" : "aggregation stage";
      items = specItems(pipelineStagesFor(kind), prefix, detail, 100);
      break;
    }
    case "stageOption":
      items = specItems(STAGE_OPTION_KEYS[context.stage ?? ""] ?? [], prefix, `${context.stage} option`, 100);
      break;
    case "methodOption":
      items = specItems(METHOD_OPTION_KEYS[context.method ?? ""] ?? [], prefix, context.method === "runCommand" ? "command" : `${context.method}() option`, 100);
      break;
    case "bulkWriteOperation":
      items = specItems(BULK_WRITE_OPERATIONS, prefix, "bulkWrite operation", 100);
      break;
    case "keyMapValue":
      items = specItems(KEY_MAP_VALUES[context.keyMap ?? ""] ?? [], prefix, `${context.keyMap} value`, 100);
      break;
    case "bulkWriteField":
      items = specItems(BULK_WRITE_OPERATION_FIELDS[context.bulkWriteOperation ?? ""] ?? [], prefix, `${context.bulkWriteOperation} field`, 100);
      break;
    case "operatorField":
      items = specItems(OPERATOR_SUB_KEYS[context.operator ?? ""] ?? [], prefix, `${context.operator} key`, 100);
      break;
    case "enumValue":
      items = enumValueItems(prefix, ENUM_VALUES[context.enumKey ?? ""] ?? [], context.enumKey ?? "");
      break;
    default:
      items = [];
  }
  return finalizeQuotedMongoCompletionItems(context, items);
}

/** Modes whose items are built from the target collection's sampled fields. */
export function mongoCompletionNeedsFields(mode: MongoCompletionMode): boolean {
  return mode === "field" || mode === "filterField" || mode === "pullCondition" || mode === "fieldPath" || mode === "fieldRef" || mode === "expression";
}

/** Modes whose items are built from the database's collection names. */
export function mongoCompletionNeedsCollections(mode: MongoCompletionMode): boolean {
  return mode === "collection" || mode === "collectionOrMethod" || mode === "collectionRef";
}

/** Modes whose items are built from the connection's database names. */
export function mongoCompletionNeedsDatabases(mode: MongoCompletionMode): boolean {
  return mode === "database";
}

export function shouldAutoOpenMongoCompletion(text: string, cursor: number): boolean {
  const previousChar = text[cursor - 1];
  if (!previousChar) return false;
  if (text.slice(0, cursor).endsWith("db.")) return true;
  // `use ` names a database next; open the list as soon as the space is typed.
  if (previousChar === " " && matchUseDatabasePrefix(text.slice(0, cursor))) return true;
  if (previousChar === "$" || previousChar === "." || previousChar === '"' || previousChar === "'") return true;
  if (/[{,[:]/.test(previousChar) || /[{,[:]\s+$/.test(text.slice(0, cursor))) {
    return getMongoCompletionContext(text, cursor).mode !== "none";
  }
  if (/[\w_$-]/.test(previousChar)) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * Standalone document inputs
 * ------------------------------------------------------------------ */

/**
 * Which bare document an input holds, and therefore how its keys read: the
 * document browser's filter bar is a query document, its sort bar a key map.
 */
export type MongoDocumentQueryKind = "filter" | "sortKeys";

/**
 * Completion for an input holding one bare document rather than a shell
 * command — the document browser's filter and sort bars.
 *
 * There is no `db.coll.find(…)` here to locate the cursor within, so the text is
 * scanned as if it *were* that call's argument list: `{ na` lands in the query
 * document's root object exactly as it would inside `find({ na`. Everything the
 * shell path reaches by walking the `db.…` chain (collection names, helper
 * methods, cursor methods) is unreachable by construction, which is what we
 * want — none of it could be pasted into a filter bar.
 */
export function getMongoDocumentQueryCompletionContext(text: string, cursor: number, kind: MongoDocumentQueryKind): MongoCompletionContext {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const nothing: MongoCompletionContext = { mode: "none", prefix: "", from: safeCursor };
  if (isInsideMongoComment(text, safeCursor)) return nothing;

  // Scanning from 0 treats the input as the argument list itself. A `}` that
  // closes more than the text opened returns null — the cursor has left the
  // document, e.g. it trails a finished `{ a: 1 }`.
  const scan = scanMongoCallArguments(text, 0, safeCursor);
  if (!scan) return nothing;

  const classified = kind === "filter" ? classifyFilter(scan, 0) : classifyKeyMap(scan, 0, "sort");
  if (classified.mode === "none") return nothing;

  const { prefix, from } = readMongoPropertyPrefix(text, safeCursor);
  return { ...classified, prefix, from, replaceClosingQuote: closingQuoteAtCursor(prefix, text, safeCursor) };
}

/**
 * Drops the `: ` a key completion carries when the text after the replaced range
 * already starts with the separator, so re-picking the key of an existing
 * `{ name: 1 }` entry yields `{ other: 1 }` rather than `{ other: : 1 }`.
 *
 * Only a plain key completion may fold its separator away. A snippet's colon
 * introduces the placeholder that follows it (`$gt: ${}`), so it is never the
 * same colon as one already in the text.
 */
export function foldMongoKeySeparator(insert: string, followingText: string): string {
  if (insert.includes("${") || !insert.endsWith(": ") || !/^\s*:/.test(followingText)) return insert;
  return insert.slice(0, -2);
}

/** Text to splice into a plain input for a chosen completion, and where to leave the selection. */
export interface MongoPlainCompletionInsertion {
  text: string;
  /** Start of the selection within `text`, relative to its first character. */
  selectionStart: number;
  /** End of that selection; equal to the start when the placeholder was empty. */
  selectionEnd: number;
}

/**
 * Renders an item's `apply` string for a plain `<input>`/`<textarea>`.
 *
 * Most operator completions are authored as CodeMirror snippets (`$in: [${}]`,
 * `$regex: "${pattern}"`), and CodeMirror expands the `${…}` markers itself.
 * Nothing does that outside the editor, so strip the markers and hand back the
 * span of the first placeholder: an empty one becomes the caret position, a
 * named one is selected so its default can be typed straight over.
 *
 * Key completions carry their own `: ` because they are only offered in key
 * position. Pass `followingText` — whatever the input holds after the replaced
 * range — so re-picking the key of an existing `{ "name": 1 }` entry replaces
 * the key instead of leaving `{ "other": : 1 }` behind.
 */
export function plainMongoCompletionInsertion(apply: string, followingText = ""): MongoPlainCompletionInsertion {
  let text = "";
  let selection: { start: number; end: number } | null = null;
  let rest = apply;

  for (;;) {
    const match = /\$\{([^{}]*)\}/.exec(rest);
    if (!match) break;
    const placeholder = match[1] ?? "";
    text += rest.slice(0, match.index);
    if (!selection) selection = { start: text.length, end: text.length + placeholder.length };
    text += placeholder;
    rest = rest.slice(match.index + match[0].length);
  }
  text += rest;

  if (!selection) text = foldMongoKeySeparator(text, followingText);

  return { text, selectionStart: Math.min(selection?.start ?? text.length, text.length), selectionEnd: Math.min(selection?.end ?? text.length, text.length) };
}

/**
 * Whether typing the character before the cursor should pop the menu open on its
 * own. Mirrors `shouldAutoOpenMongoCompletion` minus the `db.` chain, and
 * confirms the position has something to say so a space or a closing brace does
 * not reopen an empty menu.
 */
export function shouldAutoOpenMongoDocumentQueryCompletion(text: string, cursor: number, kind: MongoDocumentQueryKind): boolean {
  const previousChar = text[cursor - 1];
  if (!previousChar) return false;
  const context = getMongoDocumentQueryCompletionContext(text, cursor, kind);
  if (context.mode === "none") return false;
  return context.prefix.length > 0 || /[{[,:]\s*$/.test(text.slice(0, cursor));
}

/**
 * How far the editor may keep re-filtering a result before it has to ask us
 * again. In the `db.…` chain every `.` moves the cursor to a different item
 * source (root → collection → method → cursor method), so a result must stop
 * being valid as soon as the typed text gains a dot it did not have — otherwise
 * the editor keeps filtering collection names against `users.` and shows
 * nothing. Elsewhere (field paths, quoted collection names) dots are just part
 * of the identifier and are safe to keep.
 */
export function getMongoCompletionResultValidFor(context?: MongoCompletionContext): RegExp {
  if (!context || !DOT_SCOPED_MODES.has(context.mode)) return /["']?[\w_$.-]*$/;
  const segments = context.prefix.split(".").length;
  return new RegExp(`["']?[\\w_$-]*${"\\.[\\w_$-]*".repeat(segments - 1)}$`);
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
  /** Closed string literal values in this object container, e.g. `{ from: "orders" }`. */
  stringValues?: Record<string, string>;
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
  pipelineKind?: MongoPipelineKind;
  collection?: string;
  method?: string;
  bulkWriteOperation?: string;
  keyMap?: string;
  operator?: string;
  enumKey?: string;
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
        if (i < cursor) token += text[i];
        continue;
      }
      if (char === quote) {
        quote = null;
        if (inValue && valueKey) {
          const inner = stack[stack.length - 1];
          if (inner && inner.kind === "object") {
            inner.stringValues ??= {};
            inner.stringValues[valueKey] = token;
          }
          token = "";
        }
      } else {
        token += char;
      }
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
      stack.push({
        kind: char === "{" ? "object" : char === "[" ? "array" : "call",
        key: inValue ? valueKey : null,
        ...(char === "{" ? { stringValues: {} } : {}),
      });
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
      return classifyFilter(scan, 0);
    case "update":
      return classifyUpdateArgument(scan, 0);
    case "replacement":
    case "document":
      return { mode: classifyDocument(scan, 0) };
    case "documents":
      return { mode: classifyDocument(scan, 1) };
    case "projection":
      return classifyKeyMap(scan, 0, "projection");
    case "keys":
      return classifyKeyMap(scan, 0, "index");
    case "sortKeys":
      return classifyKeyMap(scan, 0, "sort");
    // A bare string argument naming a field, e.g. distinct("category").
    case "fieldName":
      return { mode: scan.stack.length === 0 ? "fieldPath" : "none" };
    case "pipeline":
      return classifyPipeline(scan);
    case "operations":
      return classifyBulkWriteOperations(scan);
    case "options":
      return classifyMethodOptions(method, scan);
    // `find(…).collation({ … })`, the same document as the `collation` option.
    case "collation":
      return classifyCollation(scan, 0);
    // `find(…).explain("executionStats")`.
    case "verbosity":
      return scan.stack.length === 0 ? { mode: "enumValue", enumKey: "explain" } : { mode: "none" };
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

/** Query operators whose value is a document with its own keys rather than a field's constraint object. */
const SUB_DOCUMENT_QUERY_OPERATORS = new Set(["$text", "$geoWithin", "$geoIntersects", "$near", "$nearSphere", "$geometry"]);

/** Value positions in a filter that take a fixed set of strings, by the key and the operator that holds it. */
function filterValueEnum(operator: string | null, key: string | null): string | undefined {
  if (key === "$type") return "$type";
  if (key === "$options") return "$options";
  if (key === "type" && operator === "$geometry") return "geometryType";
  return undefined;
}

function classifyFilter(scan: MongoCallScan, rootIndex: number): MongoCursorClass {
  const inner = innermost(scan);
  if (!inner || innerDepth(scan, rootIndex) < 0) return { mode: "none" };

  // Under `$jsonSchema` the vocabulary is JSON Schema, however deep the cursor sits.
  const schemaIndex = findContainerIndex(scan, rootIndex, "$jsonSchema");
  if (schemaIndex >= 0) return classifyJsonSchema(scan, schemaIndex);

  if (inner.kind === "array") {
    // `$type: ["string", "null"]` lists BSON types.
    if (inner.key === "$type") return { mode: "enumValue", enumKey: "$type" };
    // Elements of `$in: [...]` are values, so `{ _id: { $in: [ObjectId(...)] } }` completes like any value.
    return { mode: VALUE_ARRAY_OPERATORS.has(inner.key ?? "") && !scan.inString ? "value" : "none" };
  }
  if (inner.kind !== "object") return { mode: "none" };
  if (scan.inValue) {
    const enumKey = filterValueEnum(inner.key, scan.valueKey);
    if (enumKey) return { mode: "enumValue", enumKey };
    return { mode: scan.inString ? "none" : "value" };
  }
  if (innerDepth(scan, rootIndex) === 0) return { mode: "filterField" };

  // Inside a nested object: whose value is it?
  switch (inner.key) {
    case null: {
      // An object inside an array: a sub-filter under `$and` / `$or` / `$nor`,
      // or an extended JSON wrapper such as `{ $oid: ... }` under `$in`.
      const parent = scan.stack[scan.stack.length - 2];
      return { mode: parent?.kind === "array" && VALUE_ARRAY_OPERATORS.has(parent.key ?? "") ? "valueWrapper" : "filterField" };
    }
    case "$elemMatch":
      return { mode: "filterField" };
    case "$expr":
      return { mode: "expression" };
    default:
      // `$text: { … }` and the geo operators hold their own keys; anything else is a
      // field's constraint object, or `$not`, where the field operators belong.
      return SUB_DOCUMENT_QUERY_OPERATORS.has(inner.key) ? { mode: "operatorField", operator: inner.key } : { mode: "queryOperator" };
  }
}

/** Index of the innermost object container at or above `rootIndex` that is the value of `key`, or -1. */
function findContainerIndex(scan: MongoCallScan, rootIndex: number, key: string): number {
  for (let i = scan.stack.length - 1; i > rootIndex; i--) {
    const container = scan.stack[i];
    if (container?.kind === "object" && container.key === key) return i;
  }
  return -1;
}

/** Keywords whose value is itself a schema. */
const SCHEMA_NESTING_KEYWORDS = new Set(["items", "additionalItems", "additionalProperties", "not"]);
/** Keywords whose value is a list of schemas. */
const SCHEMA_LIST_KEYWORDS = new Set(["allOf", "anyOf", "oneOf"]);

/**
 * Inside `$jsonSchema: { … }`: the schema object and every schema nested in it
 * (`properties.<field>`, `items`, an `allOf` branch) take the JSON Schema keywords,
 * `properties` itself names fields, and `bsonType` / `type` take the BSON aliases.
 */
function classifyJsonSchema(scan: MongoCallScan, schemaIndex: number): MongoCursorClass {
  const inner = innermost(scan);
  if (!inner) return { mode: "none" };
  const parent = scan.stack[scan.stack.length - 2];
  const keywords: MongoCursorClass = { mode: "operatorField", operator: "$jsonSchema" };

  if (inner.kind === "array") {
    if (inner.key === "bsonType" || inner.key === "type") return { mode: "enumValue", enumKey: "bsonType" };
    if (inner.key === "required" && scan.inString) return { mode: "fieldPath" };
    return { mode: "none" };
  }
  if (inner.kind !== "object") return { mode: "none" };
  if (scan.inValue) {
    if (scan.valueKey === "bsonType" || scan.valueKey === "type") return { mode: "enumValue", enumKey: "bsonType" };
    return { mode: "none" };
  }

  if (scan.stack.length - 1 === schemaIndex) return keywords;
  if (inner.key === "properties") return { mode: "field" };
  if (inner.key === null) return parent?.kind === "array" && SCHEMA_LIST_KEYWORDS.has(parent.key ?? "") ? keywords : { mode: "none" };
  if (SCHEMA_NESTING_KEYWORDS.has(inner.key)) return keywords;
  if (parent?.key === "properties" || parent?.key === "patternProperties") return keywords;
  return { mode: "none" };
}

/** An update argument is a document of update operators, or a pipeline of the stages an update accepts. */
function classifyUpdateArgument(scan: MongoCallScan, rootIndex: number): MongoCursorClass {
  return scan.stack[rootIndex]?.kind === "array" ? classifyPipeline(scan, rootIndex, "update") : classifyUpdate(scan, rootIndex);
}

function classifyUpdate(scan: MongoCallScan, rootIndex: number): MongoCursorClass {
  const inner = innermost(scan);
  if (!inner || innerDepth(scan, rootIndex) < 0) return { mode: "none" };

  const pullIndex = findContainerIndex(scan, rootIndex, "$pull");
  if (pullIndex >= 0 && scan.stack.length > pullIndex + 1) {
    const classified = classifyFilter(scan, pullIndex + 1);
    if (innerDepth(scan, pullIndex + 1) === 0 && classified.mode === "filterField") {
      return { ...classified, mode: "pullCondition" };
    }
    return classified;
  }

  const parent = scan.stack[scan.stack.length - 2];
  if (scan.inValue) {
    // `$currentDate: { at: { $type: "timestamp" } }`.
    if (scan.valueKey === "$type" && parent?.key === "$currentDate") return { mode: "enumValue", enumKey: "currentDateType" };
    return { mode: scan.inString ? "none" : "value" };
  }
  if (inner.kind !== "object") return { mode: "none" };
  if (innerDepth(scan, rootIndex) === 0) return { mode: "updateOperator" };

  if (parent?.key === "$push" || parent?.key === "$addToSet") return { mode: "pushModifier" };
  if (parent?.key === "$currentDate") return { mode: "operatorField", operator: "$currentDate" };
  return { mode: "field" };
}

function classifyDocument(scan: MongoCallScan, rootIndex: number): MongoCompletionMode {
  const inner = innermost(scan);
  if (!inner || innerDepth(scan, rootIndex) < 0) return "none";
  if (scan.inValue) return scan.inString ? "none" : "value";
  return inner.kind === "object" ? "field" : "none";
}

/**
 * A field-to-value map: `sort({ field: -1 })`, `createIndex({ field: "text" })`, a projection.
 * Keys are field names; values are the small fixed set `keyMap` names.
 */
function classifyKeyMap(scan: MongoCallScan, rootIndex: number, keyMap: string): MongoCursorClass {
  const inner = innermost(scan);
  if (!inner || inner.kind !== "object" || innerDepth(scan, rootIndex) !== 0) return { mode: "none" };
  if (scan.inValue) return { mode: scan.inString ? "none" : "keyMapValue", keyMap };
  return { mode: "field" };
}

/** Option keys whose value is a field-to-value map, so the cursor completes field names there. */
const FIELD_MAP_OPTION_KEYS = new Set(["sort", "projection"]);

/** Option keys whose value is a fixed set of strings. */
const OPTION_VALUE_ENUMS: Record<string, string> = { returnDocument: "returnDocument", validationLevel: "validationLevel", validationAction: "validationAction" };

/** Option keys, by method, whose string value names a collection. */
const OPTION_COLLECTION_KEYS: Record<string, ReadonlySet<string>> = {
  createCollection: new Set(["viewOn"]),
  runCommand: new Set(["collStats", "listIndexes", "find", "count", "distinct", "aggregate", "insert", "update", "delete", "findAndModify", "create", "drop", "collMod", "convertToCapped", "createIndexes", "dropIndexes", "validate"]),
};

/** Option keys whose value is a filter document. */
const FILTER_OPTION_KEYS = new Set(["partialFilterExpression", "validator"]);

/** Option keys whose value is a document with its own fixed keys, and the value sets inside it. */
const SUB_DOCUMENT_OPTION_KEYS: Record<string, Record<string, string>> = {
  collation: { caseFirst: "caseFirst", alternate: "alternate", maxVariable: "maxVariable", strength: "strength" },
  timeseries: { granularity: "granularity" },
  clusteredIndex: {},
};

function classifyMethodOptions(method: string, scan: MongoCallScan): MongoCursorClass {
  const inner = innermost(scan);
  const depth = innerDepth(scan, 0);
  if (!inner || depth < 0) return { mode: "none" };

  if (depth === 0) {
    if (scan.inValue) {
      const enumKey = OPTION_VALUE_ENUMS[scan.valueKey ?? ""];
      if (enumKey) return { mode: "enumValue", enumKey, method };
      if (OPTION_COLLECTION_KEYS[method]?.has(scan.valueKey ?? "")) return { mode: "collectionRef", method };
      return { mode: "none" };
    }
    return { mode: inner.kind === "object" ? "methodOption" : "none", method };
  }

  // Which option's value holds the cursor, however deep.
  const option = scan.stack[1]?.key ?? "";
  // `{ sort: { … } }` and `{ projection: { … } }` are field maps one level in.
  if (depth === 1 && inner.kind === "object" && FIELD_MAP_OPTION_KEYS.has(option)) {
    if (!scan.inValue) return { mode: "field", method };
    return { mode: scan.inString ? "none" : "keyMapValue", method, keyMap: option };
  }
  if (FILTER_OPTION_KEYS.has(option)) return { ...classifyFilter(scan, 1), method };
  if (option === "arrayFilters") return { ...classifyFilter(scan, 2), method };
  if (option === "pipeline" && scan.stack[1]?.kind === "array") {
    return { ...classifyPipeline(scan, findPipelineArrayIndex(scan.stack), method === "createCollection" ? "view" : "aggregate"), method };
  }
  const valueEnums = SUB_DOCUMENT_OPTION_KEYS[option];
  if (valueEnums) return { ...classifySubDocument(scan, 1, option, valueEnums), method };
  return { mode: "none" };
}

/** The collation document, as the `collation` option or the `collation()` cursor method. */
function classifyCollation(scan: MongoCallScan, rootIndex: number): MongoCursorClass {
  return classifySubDocument(scan, rootIndex, "collation", SUB_DOCUMENT_OPTION_KEYS.collation ?? {});
}

/** A one-level document with a fixed key set (`OPERATOR_SUB_KEYS[operator]`) and, for some keys, a fixed value set. */
function classifySubDocument(scan: MongoCallScan, rootIndex: number, operator: string, valueEnums: Record<string, string>): MongoCursorClass {
  const inner = innermost(scan);
  if (!inner || inner.kind !== "object" || innerDepth(scan, rootIndex) !== 0) return { mode: "none" };
  if (scan.inValue) {
    const enumKey = valueEnums[scan.valueKey ?? ""];
    return enumKey ? { mode: "enumValue", enumKey } : { mode: "none" };
  }
  return { mode: "operatorField", operator };
}

/**
 * `bulkWrite([{ <operation>: { <field>: … } }])`, which nests one level deeper than the other
 * arguments: the array holds operation wrappers, each wrapper holds exactly one operation whose
 * body carries the fields, and those fields are ordinary filters, updates and documents.
 */
function classifyBulkWriteOperations(scan: MongoCallScan): MongoCursorClass {
  const arrayIndex = scan.stack.findIndex((container) => container.kind === "array");
  if (arrayIndex !== 0) return { mode: "none" };

  const wrapper = scan.stack[arrayIndex + 1];
  if (!wrapper || wrapper.kind !== "object") return { mode: "none" };

  // `[{ … }]` — naming the operation.
  if (scan.stack.length - 1 === arrayIndex + 1) {
    return { mode: scan.inValue ? "none" : "bulkWriteOperation" };
  }

  const operation = scan.stack[arrayIndex + 2]?.key ?? "";
  const fields = BULK_WRITE_OPERATION_FIELDS[operation];
  if (!fields) return { mode: "none" };

  // `[{ updateOne: { … } }]` — naming a field of the operation.
  if (scan.stack.length - 1 === arrayIndex + 2) {
    return { mode: scan.inValue ? "value" : "bulkWriteField", bulkWriteOperation: operation };
  }

  // Inside a field's value, where the shapes are the ordinary ones.
  const fieldIndex = arrayIndex + 3;
  switch (scan.stack[fieldIndex]?.key ?? "") {
    case "filter":
      return { ...classifyFilter(scan, fieldIndex), bulkWriteOperation: operation };
    case "arrayFilters":
      return { ...classifyFilter(scan, fieldIndex + 1), bulkWriteOperation: operation };
    case "update":
      return { ...classifyUpdateArgument(scan, fieldIndex), bulkWriteOperation: operation };
    case "document":
    case "replacement":
      return { mode: classifyDocument(scan, fieldIndex), bulkWriteOperation: operation };
    default:
      return { mode: "none" };
  }
}

function detectPipelineKind(scan: MongoCallScan, pipelineIndex: number, defaultKind: MongoPipelineKind = "aggregate"): MongoPipelineKind {
  if (defaultKind === "update") return "update";
  if (pipelineIndex > 0 && scan.stack[pipelineIndex - 1]?.key === "$facet") return "facet";
  if (scan.stack[pipelineIndex]?.key === "pipeline") {
    const parentKey = scan.stack[pipelineIndex - 1]?.key;
    if (parentKey === "$lookup" || parentKey === "$unionWith") return "join";
    return defaultKind;
  }
  return defaultKind;
}

/**
 * Resolves the joined collection for a sub-pipeline inside `$lookup` or `$unionWith`.
 * The innermost enclosing join stage wins; if its collection option is missing or untyped,
 * it returns undefined so completion falls back to the outer collection.
 */
function findSubPipelineJoinedCollection(scan: MongoCallScan, pipelineIndex: number): string | undefined {
  for (let i = pipelineIndex - 1; i >= 0; i--) {
    const container = scan.stack[i];
    if (container?.kind !== "object") continue;
    if (container.key === "$lookup") {
      return container.stringValues?.["from"];
    }
    if (container.key === "$unionWith") {
      return container.stringValues?.["coll"];
    }
  }
  return undefined;
}

/**
 * `kind` carries the enclosing pipeline flavor (top-level aggregate, update,
 * $facet branch, join sub-pipeline or view pipeline) so the item builder can
 * narrow the stage list.
 */
function classifyPipeline(scan: MongoCallScan, pipelineIndex = findPipelineArrayIndex(scan.stack), kind?: MongoPipelineKind): MongoCursorClass {
  if (pipelineIndex < 0) return { mode: "none" };

  const stageHolder = scan.stack[pipelineIndex + 1];
  if (!stageHolder) return { mode: "none" }; // directly inside the array, no stage object yet
  if (stageHolder.kind !== "object") return { mode: "none" };

  const pipelineKind = detectPipelineKind(scan, pipelineIndex, kind);
  const subCollection = findSubPipelineJoinedCollection(scan, pipelineIndex);

  // `[{ … }]` — the cursor is in the stage object itself.
  if (scan.stack.length - 1 === pipelineIndex + 1) {
    if (!scan.inValue) return { mode: "stage", pipelineKind, ...(subCollection ? { collection: subCollection } : {}) };
    const stage = scan.valueKey ?? "";
    return { mode: stageStringValueMode(stage), stage, ...(subCollection ? { collection: subCollection } : {}) };
  }

  const stage = scan.stack[pipelineIndex + 2]?.key ?? "";
  const classified = classifyStageBody(stage, scan, pipelineIndex + 2);
  return {
    ...classified,
    ...(subCollection && !classified.collection ? { collection: subCollection } : {}),
  };
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
  if (stage === "$match") return { ...classifyFilter(scan, bodyIndex), stage };
  if (stage === "$group") return { mode: classifyGroup(scan, bodyIndex), stage };
  if (stage === "$sort") return { ...classifyKeyMap(scan, bodyIndex, "sort"), stage };
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

  const stageBody = scan.stack[bodyIndex];

  if (depth === 0) {
    if (scan.inValue) {
      const mode = STAGE_OPTION_VALUE_MODES[stage]?.[scan.valueKey ?? ""] ?? "none";
      const isJoinedField = (stage === "$lookup" && scan.valueKey === "foreignField") || (stage === "$graphLookup" && (scan.valueKey === "connectToField" || scan.valueKey === "connectFromField"));
      const collection = isJoinedField ? stageBody?.stringValues?.["from"] : undefined;
      return {
        mode,
        stage,
        ...(collection ? { collection } : {}),
      };
    }
    return { mode: innermost(scan)?.kind === "object" ? "stageOption" : "none", stage };
  }

  if (stage === "$graphLookup" && scan.stack[bodyIndex + 1]?.key === "restrictSearchWithMatch") {
    const filterClass = classifyFilter(scan, bodyIndex + 1);
    const collection = stageBody?.stringValues?.["from"];
    return {
      ...filterClass,
      stage,
      ...(collection ? { collection } : {}),
    };
  }

  const optionHolder = scan.stack[bodyIndex + 1];
  const optionKey = optionHolder?.key ?? "";

  if (optionKey === "sortBy") {
    return { ...classifyKeyMap(scan, bodyIndex + 1, "sort"), stage };
  }

  if (optionKey === "output") {
    if (stage === "$setWindowFields") {
      if (depth === 1) {
        if (!scan.inValue) return { mode: "field", stage };
        return { mode: "none", stage };
      }
      if (depth === 2) {
        if (!scan.inValue) return { mode: "windowOperator", stage };
        return { mode: "fieldRef", stage };
      }
      if (scan.inValue) return { mode: "fieldRef", stage };
      return { mode: innermost(scan)?.kind === "object" ? "expression" : "none", stage };
    }

    if (stage === "$fill") {
      if (depth === 1) {
        if (!scan.inValue) return { mode: "field", stage };
        return { mode: "none", stage };
      }
      if (depth === 2) {
        if (!scan.inValue) return { mode: "operatorField", operator: "fillOutput", stage };
        if (scan.valueKey === "method") return { mode: "enumValue", enumKey: "fillMethod", stage };
        if (scan.valueKey === "value") return { mode: "fieldRef", stage };
        return { mode: "none", stage };
      }
    }
  }

  if (optionKey === "range" && stage === "$densify") {
    if (depth === 1) {
      if (!scan.inValue) return { mode: "operatorField", operator: "range", stage };
      if (scan.valueKey === "unit") return { mode: "enumValue", enumKey: "unit", stage };
      if (scan.valueKey === "bounds") return { mode: "enumValue", enumKey: "bounds", stage };
      if (scan.valueKey === "step") return { mode: scan.inString ? "none" : "value", stage };
      return { mode: "none", stage };
    }
    return { mode: "none", stage };
  }

  if (optionKey === "partitionByFields") {
    if (innermost(scan)?.kind === "array") return { mode: "fieldPath", stage };
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
    boost: ROOT_SNIPPET_BOOST[snippet.label],
  }));
  const methods = COLLECTION_METHODS.filter((method) => matchesFuzzyPrefix(method.label, prefix)).map((method) => ({
    label: method.label,
    type: "function" as const,
    detail: method.detail,
    apply: method.apply,
    boost: COLLECTION_METHOD_BOOST[method.label],
  }));
  return dedupeAndSort([...snippets, ...methods]);
}

function collectionItems(prefix: string, collections: string[], siblingRoot = false): MongoCompletionItem[] {
  const names = collectionNameItems(prefix, collections);
  const methods = DATABASE_METHODS.filter((method) => (siblingRoot ? method.label !== "getSiblingDB" : true) && matchesFuzzyPrefix(method.label, prefix)).map((method) => ({
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
  const hasExactCollection = collections.includes(collection);
  const hasDottedCollectionCandidate = collections.some((item) => item.startsWith(`${collection}.`));
  const collectionRef = needsGetCollectionSyntax(collection) && hasExactCollection ? `getCollection("${escapeDoubleQuoted(collection)}")` : collection;
  const methods = methodItems(methodPrefix).map((item) => ({
    ...item,
    apply: `${collectionRef}.${item.apply}`,
    filterText: `${collection}.${item.label}`,
    boost: !hasExactCollection && hasDottedCollectionCandidate ? Math.min(item.boost, 110) : item.boost,
  }));

  return dedupeAndSort([...collectionNameItems(prefix, collections, 150), ...methods]);
}

/**
 * Database names for `use <name>` and `db.getSiblingDB("<name>")`. The bare form
 * after `use` inserts the name as typed; the argument form keeps its quotes.
 */
function databaseItems(prefix: string, databases: string[]): MongoCompletionItem[] {
  const quoted = prefix.startsWith('"') || prefix.startsWith("'");
  return databases
    .filter((database) => matchesFuzzyPrefix(database, prefix))
    .slice(0, 100)
    .map((database) => ({
      label: database,
      type: "table" as const,
      detail: "database",
      apply: quoted ? quoteMongoString(database, prefix) : database,
      boost: startsWithPrefix(database, prefix) ? 120 : 90,
    }));
}

function collectionRefItems(prefix: string, collections: string[]): MongoCompletionItem[] {
  return collections
    .filter((collection) => matchesFuzzyPrefix(collection, prefix))
    .slice(0, 100)
    .map((collection) => {
      const apply = quoteMongoString(collection, prefix);
      return {
        label: collection,
        type: "table" as const,
        detail: "collection",
        apply,
        boost: startsWithPrefix(collection, prefix) ? 120 : 90,
      };
    });
}

function methodItems(prefix: string): MongoCompletionItem[] {
  return dedupeAndSort(
    COLLECTION_METHODS.filter((method) => matchesFuzzyPrefix(method.label, prefix)).map((method) => ({
      label: method.label,
      type: "function" as const,
      detail: method.detail,
      apply: method.apply,
      boost: COLLECTION_METHOD_BOOST[method.label],
    })),
  );
}

/**
 * Cursor methods offered after `find(…)` or `aggregate(…)`.
 * After `aggregate(…)`, only no-op helpers `toArray()` and `pretty()` are accepted;
 * all other cursor methods are find-only.
 */
function cursorMethodItems(prefix: string, countable: boolean, find: boolean): MongoCompletionItem[] {
  const methods = find ? [...CURSOR_METHODS, ...(countable ? [CURSOR_COUNT_METHOD] : []), ...NOOP_CURSOR_METHODS] : [...NOOP_CURSOR_METHODS];
  return dedupeAndSort(
    methods
      .filter((method) => matchesFuzzyPrefix(method.label, prefix))
      .map((method) => ({
        label: method.label,
        type: "function" as const,
        detail: method.detail,
        apply: method.apply,
        boost: method.label === "limit" ? 150 : method.label === "sort" ? 140 : method.label === "skip" ? 130 : method.label === "collation" ? 115 : method.label === "toArray" ? 100 : method.label === "pretty" ? 95 : 120,
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

/**
 * Values from a fixed set, in or out of quotes: `$type: "` and `$type: ` both offer
 * `string`. Inside a quote the item supplies only the bare value and consumes the
 * closing quote; outside it, the authored literal, quotes included.
 */
function enumValueItems(prefix: string, values: readonly MongoOperatorSpec[], category: string): MongoCompletionItem[] {
  const quoted = prefix.startsWith('"') || prefix.startsWith("'");
  const normalizedPrefix = normalizeMongoKeyPrefix(prefix);
  return values
    .filter((value) => matchesFuzzyPrefix(value.label, normalizedPrefix))
    .filter((value) => !quoted || value.apply.startsWith('"'))
    .map((value) => ({
      label: value.label,
      type: "keyword" as const,
      detail: value.detail,
      info: `${category} value`,
      apply: quoted ? quoteMongoString(value.label, prefix) : value.apply,
      boost: startsWithPrefix(value.label, normalizedPrefix) ? 120 : 90,
    }));
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

function finalizeQuotedMongoCompletionItems(context: MongoCompletionContext, items: MongoCompletionItem[]): MongoCompletionItem[] {
  const quote = context.prefix[0];
  if (quote !== '"' && quote !== "'") return items;

  return items.map((item) => {
    let apply = item.apply;
    if (apply?.startsWith(`${item.label}:`)) {
      apply = `${quote}${item.label}${quote}${apply.slice(item.label.length)}`;
    }
    return {
      ...item,
      apply,
      filterText: apply ?? `${quote}${item.label}${quote}`,
      replaceClosingQuote: context.replaceClosingQuote,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Text helpers
 * ------------------------------------------------------------------ */

const MONGO_PROPERTY_PREFIX_CHARACTER = /[$.\p{ID_Continue}-]/u;

export function readMongoPropertyPrefix(text: string, cursor: number): { prefix: string; from: number } {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const quoteStart = findOpenMongoQuoteStart(text, safeCursor);
  if (quoteStart !== null) return { prefix: text.slice(quoteStart, safeCursor), from: quoteStart };

  let from = safeCursor;
  while (from > 0) {
    let candidateFrom = from - 1;
    const trailingUnit = text.charCodeAt(candidateFrom);
    if (trailingUnit >= 0xdc00 && trailingUnit <= 0xdfff && candidateFrom > 0) {
      const leadingUnit = text.charCodeAt(candidateFrom - 1);
      if (leadingUnit >= 0xd800 && leadingUnit <= 0xdbff) candidateFrom--;
    }
    const candidate = text.slice(candidateFrom, from);
    if (!MONGO_PROPERTY_PREFIX_CHARACTER.test(candidate)) break;
    from = candidateFrom;
  }
  return { prefix: text.slice(from, safeCursor), from };
}

function findOpenMongoQuoteStart(text: string, cursor: number): number | null {
  for (let index = 0; index < cursor; index++) {
    const char = text[index];
    if ((char === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) || (char === "-" && text[index + 1] === "-")) {
      const skipped = skipMongoStringOrComment(text, index, cursor);
      if (skipped >= cursor) return null;
      index = skipped - 1;
      continue;
    }
    if (char !== '"' && char !== "'") continue;

    const quoteStart = index;
    for (index++; index < cursor; index++) {
      if (text[index] === "\\") index++;
      else if (text[index] === char) break;
    }
    if (index >= cursor) return quoteStart;
  }
  return null;
}

function closingQuoteAtCursor(prefix: string, text: string, cursor: number): '"' | "'" | undefined {
  const quote = prefix[0];
  return (quote === '"' || quote === "'") && text[cursor] === quote ? quote : undefined;
}

function readMethodPrefix(beforeCursor: string): { prefix: string; from: number } {
  const dot = beforeCursor.lastIndexOf(".");
  const from = dot >= 0 ? dot + 1 : beforeCursor.length;
  return { prefix: beforeCursor.slice(from), from };
}

/**
 * The database a command is addressed to: `db`, or another database through
 * `db.getSiblingDB("other")`. The commands are otherwise identical, so every matcher below
 * accepts either root rather than only a literal `db.`.
 */
const DB_ROOT = String.raw`db(?:\s*\.\s*getSiblingDB\s*\(\s*(?:"[^"]*"|'[^']*')\s*\))?`;
const SIBLING_ROOT_PATTERN = String.raw`db\s*\.\s*getSiblingDB\s*\(\s*(?:"[^"]*"|'[^']*')\s*\)`;
const COLLECTION_REF = String.raw`(?:[A-Za-z_][\w$-]*|getCollection\(["'][^"']+["']\))`;

/** `db.` or `db.getSiblingDB("other").` immediately before the cursor. */
function endsAtDbRootDot(beforeCursor: string): boolean {
  return new RegExp(String.raw`(?:^|[\s;(])${DB_ROOT}\s*\.$`).test(beforeCursor);
}

function endsAtSiblingRootDot(beforeCursor: string): boolean {
  return new RegExp(String.raw`(?:^|[\s;(])${SIBLING_ROOT_PATTERN}\s*\.$`).test(beforeCursor);
}

function matchDbCollectionPrefix(beforeCursor: string): { prefix: string; from: number } | null {
  const match = new RegExp(String.raw`(?:^|[\s;(])${DB_ROOT}\.([A-Za-z_][\w$-]*(?:\.[\w$-]*)*)$`).exec(beforeCursor);
  if (!match) return null;
  const prefix = match[1] ?? "";
  return { prefix, from: beforeCursor.length - prefix.length };
}

function matchSiblingCollectionPrefix(beforeCursor: string): boolean {
  return new RegExp(String.raw`(?:^|[\s;(])${SIBLING_ROOT_PATTERN}\s*\.([A-Za-z_][\w$-]*(?:\.[\w$-]*)*)$`).test(beforeCursor);
}

const MONGO_COMMAND_LINE_START_PATTERN = /(?:use\b|show\s+(?:dbs|databases|collections)\b|db(?:\s*\.|\b))/iy;

function isMongoCommandLineStart(text: string, index: number): boolean {
  MONGO_COMMAND_LINE_START_PATTERN.lastIndex = index;
  return MONGO_COMMAND_LINE_START_PATTERN.test(text);
}

/** Cursor inside the string argument of `db.getSiblingDB(`, with the opening quote as part of the prefix. */
function matchGetSiblingDbPrefix(beforeCursor: string): { prefix: string; from: number } | null {
  const match = /(?:^|[\s;(])db\s*\.\s*getSiblingDB\s*\(\s*(["'][^"'\\]*)$/.exec(beforeCursor);
  if (!match) return null;
  const prefix = match[1] ?? "";
  return { prefix, from: beforeCursor.length - prefix.length };
}

/**
 * Cursor in the bare database name after a `use` command. A quoted name is not
 * valid there, so it stays unmatched, and a field called `use` inside an argument
 * list is a key, not the command.
 */
function matchUseDatabasePrefix(beforeCursor: string): { prefix: string; from: number } | null {
  const match = /(?:^|[\s;])use\s+([^\s;"'()]*)$/.exec(maskMongoLiterals(beforeCursor));
  if (!match || isInsideCallArguments(beforeCursor)) return null;
  const prefix = match[1] ?? "";
  return { prefix: beforeCursor.slice(beforeCursor.length - prefix.length), from: beforeCursor.length - prefix.length };
}

function matchGetCollectionPrefix(beforeCursor: string): { prefix: string; from: number } | null {
  const match = new RegExp(String.raw`(?:^|[\s;(])${DB_ROOT}\.getCollection\(\s*(["'][^"'\\]*)$`).exec(beforeCursor);
  if (!match) return null;
  const prefix = match[1] ?? "";
  return { prefix, from: beforeCursor.length - prefix.length };
}

function isAfterCollectionDot(beforeCursor: string): boolean {
  return new RegExp(String.raw`(?:^|[\s;(])${DB_ROOT}\.${COLLECTION_REF}\.[\w$-]*$`).test(beforeCursor);
}

/**
 * `db.x.find(…).…` or `db.x.aggregate(…).…` — matches cursor method chaining positions.
 * Recognises find chains (including terminal `count()` and `explain()`), and aggregate
 * chains (which only accept `toArray()` and `pretty()`).
 */
function matchCursorMethodDot(beforeCursor: string): { find: boolean; countable: boolean; terminal?: boolean } | null {
  const collectionCall = new RegExp(String.raw`(?:^|[\s;(])${DB_ROOT}\.${COLLECTION_REF}\.(find|aggregate)\s*\(`, "g");
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = collectionCall.exec(beforeCursor))) lastMatch = match;
  if (!lastMatch) return null;

  const openParen = beforeCursor.indexOf("(", lastMatch.index + lastMatch[0].length - 1);
  const closeParen = findMatchingParen(beforeCursor, openParen);
  if (closeParen < 0) return null;

  const chain = beforeCursor.slice(closeParen + 1);
  if (!/\.\s*[\w$-]*$/.test(chain)) return null;

  const isFind = lastMatch[1] === "find";
  if (/\.\s*(?:count|explain)\s*\([^()]*\)/.test(chain)) {
    return { find: isFind, countable: false, terminal: true };
  }

  if (isFind) {
    if (!/^(?:\s*\.\s*(?:sort|skip|limit|collation|toArray|pretty)\s*\([^()]*\))*\s*\.\s*[\w$-]*$/.test(chain)) return null;
    return { find: true, countable: /^\s*\.\s*[\w$-]*$/.test(chain) };
  }

  if (!/^(?:\s*\.\s*(?:toArray|pretty)\s*\([^()]*\))*\s*\.\s*[\w$-]*$/.test(chain)) {
    return { find: false, countable: false, terminal: true };
  }
  return { find: false, countable: false };
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

/**
 * Whether the cursor sits inside an unclosed `(` of the current command. Literals and comments
 * are masked first so a parenthesis inside a string does not count, and the depth resets at `;`
 * because an unclosed call cannot span two commands.
 */
function isInsideCallArguments(beforeCursor: string): boolean {
  const masked = maskMongoLiterals(beforeCursor);
  let depth = 0;
  for (const char of masked) {
    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === ";") depth = 0;
  }
  return depth > 0;
}

/** After `use` with something `matchUseDatabasePrefix` rejects (a quoted or parenthesised name), so no snippets belong there. */
function isAfterUseKeyword(beforeCursor: string): boolean {
  return /(?:^|[\s;])use\s+[\w$-]*$/.test(maskMongoLiterals(beforeCursor));
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
  const getCollectionMatches = [...before.matchAll(new RegExp(String.raw`${DB_ROOT}\.getCollection\(["']([^"']+)["']\)`, "g"))];
  const directMatches = [...before.matchAll(new RegExp(String.raw`${DB_ROOT}\.([A-Za-z_][\w$-]*)\s*\.`, "g"))].filter((match) => match[1] !== "getCollection");
  const lastGetCollection = getCollectionMatches[getCollectionMatches.length - 1];
  const lastDirect = directMatches[directMatches.length - 1];
  const getCollectionIndex = lastGetCollection?.index ?? -1;
  const directIndex = lastDirect?.index ?? -1;
  if (getCollectionIndex > directIndex) return lastGetCollection?.[1];
  return lastDirect?.[1];
}

const USE_COMMAND_PATTERN = /use\s+([a-zA-Z0-9_-]+)(?=[\s;]|$)/iy;

/**
 * Resolves the database targeted by the command at the cursor.
 *
 * If the current command explicitly addresses another database via `db.getSiblingDB("name")`,
 * that database takes precedence. Otherwise, the database set by the last preceding top-level
 * `use <name>` command applies. If neither is present, returns undefined so the editor's active
 * database continues to apply.
 */
function extractActiveDatabase(text: string, cursor: number): string | undefined {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, safeCursor);
  const masked = maskMongoLiterals(before);

  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let currentCommandStart = 0;
  let lastUseDb: string | undefined = undefined;

  let i = 0;
  while (i < masked.length) {
    const isTopLevel = parenDepth === 0 && bracketDepth === 0 && braceDepth === 0;

    if (isTopLevel) {
      const prevChar = i > 0 ? masked[i - 1] : "\n";
      if (/[\s;]/.test(prevChar)) {
        USE_COMMAND_PATTERN.lastIndex = i;
        const useMatch = USE_COMMAND_PATTERN.exec(masked);
        if (useMatch) {
          lastUseDb = useMatch[1];
          currentCommandStart = i;
          i += useMatch[0].length;
          continue;
        }
      }

      if (masked[i] === ";") {
        let next = i + 1;
        while (next < masked.length && /\s/.test(masked[next])) next++;
        currentCommandStart = next;
      } else if (masked[i] === "\n") {
        let next = i + 1;
        while (next < masked.length && (masked[next] === " " || masked[next] === "\t")) next++;
        if (next < masked.length && isMongoCommandLineStart(masked, next)) {
          currentCommandStart = next;
        }
      }
    }

    const char = masked[i];
    if (char === "(") parenDepth++;
    else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (char === "[") bracketDepth++;
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === "{") braceDepth++;
    else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);

    i++;
  }

  const currentCommandText = before.slice(currentCommandStart);
  const siblingMatches = [...currentCommandText.matchAll(/(?:^|[\s;(])db\s*\.\s*getSiblingDB\s*\(\s*(?:(["'])([^"']*)\1|[^\s)]+)?\s*\)/gi)];
  if (siblingMatches.length > 0) {
    const lastMatch = siblingMatches[siblingMatches.length - 1];
    return lastMatch?.[2] || undefined;
  }

  return lastUseDb;
}

function collectFieldTypes(value: unknown, prefix: string, out: Map<string, Set<string>>, depth: number) {
  if (depth > 4 || value == null || typeof value !== "object") return;
  // A wrapper such as {$oid: "..."} is one BSON value. Walking into it would offer
  // `_id.$oid`, a path that exists only in transport and matches nothing on the server.
  if (mongoExtendedJsonValueType(value)) return;
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
  return mongoExtendedJsonValueType(value) ?? (typeof value === "object" ? "object" : typeof value);
}

/**
 * Keys that may be written bare. Anything else has to carry quotes: a nested
 * path (`customer.name`) is the common case, but a hyphen or a leading digit
 * does it too. `inferMongoCompletionFields` emits a path per nesting level, so
 * a collection of nested documents offers mostly non-bare keys.
 */
const BARE_MONGO_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Renders a field name in key position. An unquoted prefix keeps the key bare
 * only while the name allows it — `{ customer.name: 1 }` parses neither as a
 * shell document nor as the JSON the document browser's query bars are read
 * as, so a path is quoted even though the user typed no quote.
 */
function quoteMongoFieldName(field: string, prefix: string): string {
  if (prefix.startsWith("'")) return `'${escapeSingleQuoted(field)}'`;
  if (prefix.startsWith('"') || !BARE_MONGO_KEY.test(field)) return `"${escapeDoubleQuoted(field)}"`;
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
