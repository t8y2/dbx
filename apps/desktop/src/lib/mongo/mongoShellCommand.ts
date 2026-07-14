import type { QueryResult } from "@/types/database";
import { mongoDocumentIdForGrid } from "@/lib/mongo/mongoDocumentValues";

export interface MongoFindCommand {
  collection: string;
  filter: string;
  projection?: string;
  skip: number;
  limit: number;
  sort?: string;
}

export interface MongoCountDocumentsCommand {
  collection: string;
  filter: string;
  mode: "accurate" | "legacy";
}

export interface MongoAggregateCommand {
  collection: string;
  pipeline: string;
}

export interface MongoGetIndexesCommand {
  collection: string;
}

export interface MongoUseCommand {
  database: string;
}

export interface MongoVersionCommand {
  kind: "version";
}

export type MongoCollectionStatsMetric = "stats" | "dataSize" | "storageSize" | "totalIndexSize";

export interface MongoCollectionStatsCommand {
  collection: string;
  metric: MongoCollectionStatsMetric;
  scale?: number;
}

type MongoWriteKind = "insert" | "update" | "delete" | "createIndex" | "dropIndex" | "dropIndexes" | "dropCollection";

export type MongoCommand =
  | ({ kind: "find" } & MongoFindCommand)
  | MongoVersionCommand
  | ({ kind: "countDocuments" } & MongoCountDocumentsCommand)
  | ({ kind: "aggregate" } & MongoAggregateCommand)
  | ({ kind: "getIndexes" } & MongoGetIndexesCommand)
  | ({ kind: "collectionStats" } & MongoCollectionStatsCommand)
  | ({ kind: "use" } & MongoUseCommand)
  | { kind: "insert"; collection: string; docsJson: string }
  | { kind: "update"; collection: string; filter: string; update: string; options?: string; many: boolean }
  | { kind: "delete"; collection: string; filter: string; many: boolean }
  | { kind: "createIndex"; collection: string; keys: string; options?: string }
  | { kind: "dropIndex"; collection: string; index: string }
  | { kind: "dropIndexes"; collection: string; indexes?: string }
  | { kind: "dropCollection"; collection: string };

export type MongoWriteCommand = Extract<MongoCommand, { kind: MongoWriteKind }>;

export interface ParsedMongoCommand {
  text: string;
  command: MongoCommand;
}

export interface ParsedMongoCommandRange extends ParsedMongoCommand {
  from: number;
  to: number;
}

export interface MongoAggregateSafetyOptions {
  allowWrites?: boolean;
  allowDangerous?: boolean;
}

const DEFAULT_LIMIT = 100;

export function parseMongoFindCommand(input: string): MongoFindCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  const target = parseFindTarget(source);
  if (!target) return null;

  const findOpenIndex = source.indexOf("(", target.findCallIndex);
  const findCloseIndex = findMatchingParen(source, findOpenIndex);
  if (findCloseIndex < 0) return null;

  const findArgs = splitTopLevel(source.slice(findOpenIndex + 1, findCloseIndex));
  if (findArgs.length > 2 && findArgs.slice(2).some((arg) => arg.trim())) return null;
  const filter = normalizeJsonArgument(findArgs[0] || "{}");
  if (!filter) return null;
  let projection: string | undefined;
  if (findArgs[1]?.trim()) {
    const parsedProjection = normalizeJsonArgument(findArgs[1]);
    if (!parsedProjection) return null;
    projection = parsedProjection;
  }

  const chain = source.slice(findCloseIndex + 1).trim();
  if (chain && !chain.startsWith(".")) return null;
  if (findChainedMethodCallIndex(chain, "count") >= 0) return null;

  const sortArg = readChainedCallArgument(chain, "sort");
  let sort: string | undefined;
  if (sortArg !== undefined) {
    const parsedSort = normalizeJsonArgument(sortArg);
    if (!parsedSort) return null;
    sort = parsedSort;
  }

  const skip = readChainedIntegerArgument(chain, "skip", 0);
  const limit = readChainedIntegerArgument(chain, "limit", DEFAULT_LIMIT);
  if (skip === null || limit === null) return null;

  return {
    collection: target.collection,
    filter,
    ...(projection ? { projection } : {}),
    skip,
    limit,
    sort,
  };
}

export function applyMongoFindSort(input: string, column: string, direction: "asc" | "desc"): string | null {
  const source = input.trim().replace(/;$/, "").trim();
  const parsed = parseMongoFindCommand(source);
  if (!parsed) return null;

  const target = parseFindTarget(source);
  if (!target) return null;

  const findOpenIndex = source.indexOf("(", target.findCallIndex);
  const findCloseIndex = findMatchingParen(source, findOpenIndex);
  if (findCloseIndex < 0) return null;

  const prefix = source.slice(0, findCloseIndex + 1);
  const chainSource = source.slice(findCloseIndex + 1).trim();
  if (chainSource && !chainSource.startsWith(".")) return null;

  const chain = removeChainedMethodCall(chainSource, "sort");
  const sortCall = `.sort(${JSON.stringify({ [column]: direction === "asc" ? 1 : -1 })})`;
  return `${prefix}${sortCall}${chain}`;
}

export function parseMongoCountDocumentsCommand(input: string): MongoCountDocumentsCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  return parseCollectionCountCommand(source, "countDocuments") ?? parseCollectionCountCommand(source, "count") ?? parseFindCountCommand(source);
}

function parseCollectionCountCommand(source: string, method: "countDocuments" | "count"): MongoCountDocumentsCommand | null {
  const target = parseCollectionMethodTarget(source, method);
  if (!target) return null;

  const openIndex = source.indexOf("(", target.methodCallIndex);
  const closeIndex = findMatchingParen(source, openIndex);
  if (closeIndex < 0 || source.slice(closeIndex + 1).trim()) return null;

  const args = splitTopLevel(source.slice(openIndex + 1, closeIndex));
  if (args.length > 1 && args.slice(1).some((arg) => arg.trim())) return null;
  const filter = normalizeJsonArgument(args[0] || "{}");
  if (!filter) return null;

  return {
    collection: target.collection,
    filter,
    mode: method === "countDocuments" ? "accurate" : "legacy",
  };
}

function parseFindCountCommand(source: string): MongoCountDocumentsCommand | null {
  const target = parseFindTarget(source);
  if (!target) return null;

  const findOpenIndex = source.indexOf("(", target.findCallIndex);
  const findCloseIndex = findMatchingParen(source, findOpenIndex);
  if (findCloseIndex < 0) return null;

  const chain = source.slice(findCloseIndex + 1).trim();
  if (!hasSingleEmptyChainedCall(chain, "count")) return null;

  const findArgs = splitTopLevel(source.slice(findOpenIndex + 1, findCloseIndex));
  if (findArgs.length > 2 && findArgs.slice(2).some((arg) => arg.trim())) return null;
  const filter = normalizeJsonArgument(findArgs[0] || "{}");
  if (!filter) return null;

  return {
    collection: target.collection,
    filter,
    mode: "legacy",
  };
}

export function parseMongoAggregateCommand(input: string): MongoAggregateCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  const target = parseCollectionMethodTarget(source, "aggregate");
  if (!target) return null;

  const openIndex = source.indexOf("(", target.methodCallIndex);
  const closeIndex = findMatchingParen(source, openIndex);
  if (closeIndex < 0 || source.slice(closeIndex + 1).trim()) return null;

  const args = splitTopLevel(source.slice(openIndex + 1, closeIndex));
  if (args.length !== 1) return null;
  const pipeline = normalizeJsonArgument(args[0]);
  if (!pipeline) return null;
  try {
    if (!Array.isArray(JSON.parse(pipeline))) return null;
  } catch {
    return null;
  }

  return {
    collection: target.collection,
    pipeline,
  };
}

export function parseMongoGetIndexesCommand(input: string): MongoGetIndexesCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  const target = parseCollectionMethodTarget(source, "getIndexes");
  if (!target) return null;

  const openIndex = source.indexOf("(", target.methodCallIndex);
  const closeIndex = findMatchingParen(source, openIndex);
  if (closeIndex < 0 || source.slice(closeIndex + 1).trim()) return null;

  const args = splitTopLevel(source.slice(openIndex + 1, closeIndex));
  if (args.some((arg) => arg.trim())) return null;

  return {
    collection: target.collection,
  };
}

export function parseMongoCollectionStatsCommand(input: string): MongoCollectionStatsCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  for (const metric of ["stats", "dataSize", "storageSize", "totalIndexSize"] as const) {
    const target = parseCollectionMethodTarget(source, metric);
    if (!target) continue;
    const args = parseMethodArgs(source, target.methodCallIndex);
    if (!args) return null;
    const scale = parseMongoCollectionStatsScale(args);
    return scale === null ? null : { collection: target.collection, metric, ...(scale === undefined ? {} : { scale }) };
  }
  return null;
}

function parseMongoCollectionStatsScale(args: string[]): number | undefined | null {
  if (args.length === 1 && !args[0]?.trim()) return undefined;
  if (args.length !== 1) return null;
  const raw = args[0].trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) return null;
  const scale = Number(raw);
  if (!Number.isFinite(scale)) return null;
  return scale;
}

export function parseMongoUseCommand(input: string): MongoUseCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  const match = /^use\s+([a-zA-Z0-9_-]+)$/i.exec(source);
  if (!match) return null;
  return {
    database: match[1],
  };
}

export function parseMongoVersionCommand(input: string): MongoVersionCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  return /^db\s*\.\s*version\s*\(\s*\)$/i.test(source) ? { kind: "version" } : null;
}

export function parseMongoWriteCommand(input: string): MongoWriteCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  const insertOne = parseCollectionMethodTarget(source, "insertOne");
  if (insertOne) {
    const args = parseMethodArgs(source, insertOne.methodCallIndex);
    if (!args || args.length !== 1) return null;
    const doc = normalizeJsonArgument(args[0]);
    return doc ? { kind: "insert", collection: insertOne.collection, docsJson: doc } : null;
  }

  const insertMany = parseCollectionMethodTarget(source, "insertMany");
  if (insertMany) {
    const args = parseMethodArgs(source, insertMany.methodCallIndex);
    if (!args || args.length !== 1) return null;
    const docs = normalizeJsonArgument(args[0]);
    if (!docs) return null;
    return Array.isArray(JSON.parse(docs)) ? { kind: "insert", collection: insertMany.collection, docsJson: docs } : null;
  }

  for (const method of ["updateOne", "updateMany"] as const) {
    const target = parseCollectionMethodTarget(source, method);
    if (!target) continue;
    const args = parseMethodArgs(source, target.methodCallIndex);
    if (!args || args.length < 2 || args.length > 3) return null;
    const filter = normalizeJsonArgument(args[0]);
    const update = normalizeJsonArgument(args[1]);
    if (!filter || !update) return null;
    const options = args[2]?.trim() ? normalizeJsonArgument(args[2]) : undefined;
    if (args[2]?.trim() && !options) return null;
    return { kind: "update", collection: target.collection, filter, update, ...(options ? { options } : {}), many: method === "updateMany" };
  }

  for (const method of ["deleteOne", "deleteMany"] as const) {
    const target = parseCollectionMethodTarget(source, method);
    if (!target) continue;
    const args = parseMethodArgs(source, target.methodCallIndex);
    if (!args || args.length !== 1) return null;
    const filter = normalizeJsonArgument(args[0]);
    if (!filter) return null;
    return { kind: "delete", collection: target.collection, filter, many: method === "deleteMany" };
  }

  const createIndex = parseCollectionMethodTarget(source, "createIndex");
  if (createIndex) {
    const args = parseMethodArgs(source, createIndex.methodCallIndex);
    if (!args || args.length < 1 || args.length > 2) return null;
    const keys = normalizeJsonArgument(args[0]);
    if (!keys) return null;
    let options: string | undefined;
    if (args[1]?.trim()) {
      const parsedOptions = normalizeJsonArgument(args[1]);
      if (!parsedOptions) return null;
      options = parsedOptions;
    }
    return { kind: "createIndex", collection: createIndex.collection, keys, ...(options ? { options } : {}) };
  }

  const dropIndex = parseCollectionMethodTarget(source, "dropIndex");
  if (dropIndex) {
    const args = parseMethodArgs(source, dropIndex.methodCallIndex);
    if (!args) return null;
    const index = parseMongoDropIndexArgument(args);
    return index ? { kind: "dropIndex", collection: dropIndex.collection, index } : null;
  }

  const dropIndexes = parseCollectionMethodTarget(source, "dropIndexes");
  if (dropIndexes) {
    const args = parseMethodArgs(source, dropIndexes.methodCallIndex);
    if (!args) return null;
    const indexes = parseMongoDropIndexesArgument(args);
    return indexes !== null ? { kind: "dropIndexes", collection: dropIndexes.collection, ...(indexes ? { indexes } : {}) } : null;
  }

  const dropCollection = parseCollectionMethodTarget(source, "drop");
  if (dropCollection) {
    const args = parseMethodArgs(source, dropCollection.methodCallIndex);
    if (!args || args.some((arg) => arg.trim())) return null;
    return { kind: "dropCollection", collection: dropCollection.collection };
  }

  return null;
}

export function parseMongoCommand(input: string): ParsedMongoCommand | null {
  const text = trimMongoOuterComments(input);
  if (!text) return null;

  // Keep the more specific readers ahead of generic write parsing so the
  // returned kind matches the result renderer we want to use downstream.
  const parsers: Array<(source: string) => MongoCommand | null> = [
    (source) => {
      const version = parseMongoVersionCommand(source);
      return version ?? null;
    },
    (source) => {
      // Legacy Mongo shell uses count()/find().count(); keep accepting it
      // while mapping to DBX's countDocuments-compatible result path.
      const count = parseMongoCountDocumentsCommand(source);
      return count ? { kind: "countDocuments", ...count } : null;
    },
    (source) => {
      const find = parseMongoFindCommand(source);
      return find ? { kind: "find", ...find } : null;
    },
    (source) => {
      const aggregate = parseMongoAggregateCommand(source);
      return aggregate ? { kind: "aggregate", ...aggregate } : null;
    },
    (source) => {
      const getIndexes = parseMongoGetIndexesCommand(source);
      return getIndexes ? { kind: "getIndexes", ...getIndexes } : null;
    },
    (source) => {
      const stats = parseMongoCollectionStatsCommand(source);
      return stats ? { kind: "collectionStats", ...stats } : null;
    },
    (source) => {
      const write = parseMongoWriteCommand(source);
      return write ?? null;
    },
    (source) => {
      const use = parseMongoUseCommand(source);
      return use ? { kind: "use", ...use } : null;
    },
  ];

  for (const parse of parsers) {
    const command = parse(text);
    if (command) return { text, command };
  }

  return null;
}

export function splitMongoCommands(input: string): ParsedMongoCommand[] {
  return splitMongoCommandRanges(input).map(({ from: _from, to: _to, ...command }) => command);
}

export function splitMongoCommandRanges(input: string): ParsedMongoCommandRange[] {
  const commands: ParsedMongoCommandRange[] = [];
  for (const segment of splitMongoCommandTextRanges(input)) {
    const parsed = parseMongoCommand(segment.text);
    if (!parsed) return [];
    commands.push({ from: segment.from, to: segment.to, ...parsed });
  }
  return commands;
}

export function evaluateMongoWriteSafety(command: MongoWriteCommand, options: MongoAggregateSafetyOptions): { allowed: boolean; reason?: string } {
  if (!options.allowWrites) {
    return {
      allowed: false,
      reason: "MCP MongoDB execution is read-only by default. Set DBX_MCP_ALLOW_WRITES=1 to allow write commands.",
    };
  }
  if (!options.allowDangerous && (command.kind === "update" || command.kind === "delete") && isEmptyJsonObject(command.filter)) {
    return {
      allowed: false,
      reason: "MongoDB update/delete commands must include a non-empty filter unless DBX_MCP_ALLOW_DANGEROUS_SQL=1 is set.",
    };
  }
  if (!options.allowDangerous && mongoDropIndexesRequiresDangerous(command)) {
    return {
      allowed: false,
      reason: "MongoDB dropIndexes() without a specific single index requires DBX_MCP_ALLOW_DANGEROUS_SQL=1.",
    };
  }
  if (!options.allowDangerous && command.kind === "dropCollection") {
    return {
      allowed: false,
      reason: "MongoDB drop() requires DBX_MCP_ALLOW_DANGEROUS_SQL=1.",
    };
  }
  return { allowed: true };
}

export function mongoAggregateWriteStage(pipelineJson: string): "$out" | "$merge" | null {
  try {
    const pipeline = JSON.parse(pipelineJson);
    if (!Array.isArray(pipeline)) return null;
    for (const stage of pipeline) {
      if (!isRecord(stage)) continue;
      if (Object.prototype.hasOwnProperty.call(stage, "$out")) return "$out";
      if (Object.prototype.hasOwnProperty.call(stage, "$merge")) return "$merge";
    }
  } catch {
    return null;
  }
  return null;
}

export function evaluateMongoAggregateSafety(command: MongoAggregateCommand, options: MongoAggregateSafetyOptions): { allowed: boolean; reason?: string } {
  const writeStage = mongoAggregateWriteStage(command.pipeline);
  if (!writeStage) return { allowed: true };
  if (!options.allowWrites) {
    return {
      allowed: false,
      reason: `MongoDB aggregate stage "${writeStage}" writes data. Set DBX_MCP_ALLOW_WRITES=1 to allow write commands.`,
    };
  }
  if (!options.allowDangerous) {
    return {
      allowed: false,
      reason: `MongoDB aggregate stage "${writeStage}" is dangerous. Set DBX_MCP_ALLOW_DANGEROUS_SQL=1 to allow it.`,
    };
  }
  return { allowed: true };
}

export function mongoDocumentsToQueryResult(documents: unknown[], executionTimeMs: number, total: number): QueryResult {
  const columns: string[] = [];

  for (const doc of documents) {
    if (isRecord(doc)) {
      for (const key of Object.keys(doc)) {
        if (!columns.includes(key)) columns.push(key);
      }
    } else if (!columns.includes("value")) {
      columns.push("value");
    }
  }

  const rows = documents.map((doc) => {
    if (isRecord(doc)) return columns.map((column) => toCellValue(doc[column]));
    return columns.map((column) => (column === "value" ? toCellValue(doc) : null));
  });

  return {
    columns,
    rows,
    mongo_documents: documents,
    affected_rows: total,
    execution_time_ms: Math.max(0, Math.round(executionTimeMs)),
    truncated: total > documents.length,
  };
}

export function mongoCountToQueryResult(total: number, executionTimeMs: number): QueryResult {
  return {
    columns: ["count"],
    rows: [[total]],
    affected_rows: total,
    execution_time_ms: Math.max(0, Math.round(executionTimeMs)),
  };
}

export function mongoWriteToQueryResult(affectedRows: number, executionTimeMs: number): QueryResult {
  return {
    columns: [],
    rows: [],
    affected_rows: affectedRows,
    execution_time_ms: Math.max(0, Math.round(executionTimeMs)),
  };
}

export function mongoCreateIndexToQueryResult(name: string, executionTimeMs: number): QueryResult {
  return {
    columns: ["name"],
    rows: [[name]],
    affected_rows: 1,
    execution_time_ms: Math.max(0, Math.round(executionTimeMs)),
  };
}

export function mongoDroppedIndexesToQueryResult(names: string[], executionTimeMs: number): QueryResult {
  return {
    columns: ["name"],
    rows: names.map((name) => [name]),
    affected_rows: names.length,
    execution_time_ms: Math.max(0, Math.round(executionTimeMs)),
  };
}

export function mongoUseToQueryResult(database: string, executionTimeMs: number): QueryResult {
  return {
    columns: ["message"],
    rows: [[`switched to db ${database}`]],
    affected_rows: 0,
    execution_time_ms: Math.max(0, Math.round(executionTimeMs)),
  };
}

export function mongoVersionToQueryResult(version: string, executionTimeMs: number): QueryResult {
  return {
    columns: ["version"],
    rows: [[version]],
    affected_rows: 1,
    execution_time_ms: Math.max(0, Math.round(executionTimeMs)),
  };
}

export function mongoIndexesToQueryResult(
  indexes: {
    name: string;
    columns: string[];
    is_unique: boolean;
    is_primary: boolean;
    filter?: string | null;
    index_type?: string | null;
    included_columns?: string[] | null;
    comment?: string | null;
  }[],
  executionTimeMs: number,
): QueryResult {
  return {
    columns: ["name", "columns", "unique", "primary", "type", "filter"],
    rows: indexes.map((index) => [index.name, index.columns.join(", "), index.is_unique, index.is_primary, index.index_type ?? null, index.filter ?? null]),
    affected_rows: indexes.length,
    execution_time_ms: Math.max(0, Math.round(executionTimeMs)),
  };
}

export function mongoCollectionStatsToQueryResult(metric: MongoCollectionStatsMetric, stats: Record<string, unknown>, executionTimeMs: number): QueryResult {
  const execution_time_ms = Math.max(0, Math.round(executionTimeMs));
  if (metric === "stats") {
    const columns = ["count", "size", "avgObjSize", "storageSize", "totalIndexSize", "nindexes"];
    return {
      columns,
      rows: [columns.map((column) => (column in stats ? toCellValue(stats[column]) : null))],
      affected_rows: 1,
      execution_time_ms,
    };
  }
  const sourceField = metric === "dataSize" ? "size" : metric;
  return {
    columns: [metric],
    rows: [[sourceField in stats ? toCellValue(stats[sourceField]) : null]],
    affected_rows: 1,
    execution_time_ms,
  };
}

function parseFindTarget(source: string): { collection: string; findCallIndex: number } | null {
  const direct = parseCollectionMethodTarget(source, "find");
  if (direct) {
    return { collection: direct.collection, findCallIndex: direct.methodCallIndex };
  }

  return null;
}

function parseCollectionMethodTarget(source: string, method: string): { collection: string; methodCallIndex: number } | null {
  const escapedMethod = escapeRegExp(method);
  const direct = new RegExp(`^db\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\.\\s*${escapedMethod}\\s*\\(`).exec(source);
  if (direct) {
    return {
      collection: direct[1],
      methodCallIndex: findChainedMethodCallIndex(source, method),
    };
  }

  const getCollection = new RegExp(`^db\\s*\\.\\s*getCollection\\s*\\(\\s*(["'])(.*?)\\1\\s*\\)\\s*\\.\\s*${escapedMethod}\\s*\\(`).exec(source);
  if (getCollection) {
    return {
      collection: getCollection[2],
      methodCallIndex: findChainedMethodCallIndex(source, method),
    };
  }

  return null;
}

function normalizeJsonArgument(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "{}";
  // Rewrite mongo shell constructors that are not valid JSON into the extended
  // JSON the backend understands (mongo_driver::json_value_to_bson): ObjectId(x)
  // -> {"$oid":x}, NumberLong(x) -> {"$numberLong":x}, and
  // ISODate(x)/new Date(x) -> {"$date":x}. Without this a
  // filter such as { createdAt: { $gte: ISODate("...") } } fails JSON.parse,
  // the command is left unrecognized and falls through to the SQL executor,
  // which rejects it with "Use MongoDB-specific commands".
  const withExtendedJson = replaceMongoShellConstructors(trimmed);
  const preprocessed = quoteUnquotedObjectKeys(convertSingleQuotedStrings(withExtendedJson));
  try {
    JSON.parse(preprocessed);
    return preprocessed;
  } catch {
    return null;
  }
}

function replaceMongoShellConstructors(source: string): string {
  const constructor = /^(ObjectId|NumberLong|ISODate)\s*\(\s*["']([^"']+)["']\s*\)|^(ObjectId|NumberLong)\s*\(\s*(-?\d+)\s*\)|^(?:new\s+Date)\s*\(\s*["']([^"']+)["']\s*\)/;
  let result = "";
  let index = 0;
  while (index < source.length) {
    const quote = source[index];
    if (quote === '"' || quote === "'") {
      const start = index++;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === quote) {
          index++;
          break;
        } else index++;
      }
      result += source.slice(start, index);
      continue;
    }
    const match = source.slice(index).match(constructor);
    if (!match) {
      result += source[index++];
      continue;
    }
    if (match[1]) {
      result += match[1] === "ObjectId" ? `{"$oid":"${match[2]}"}` : match[1] === "NumberLong" ? `{"$numberLong":"${match[2]}"}` : `{"$date":"${match[2]}"}`;
    } else if (match[3]) {
      result += match[3] === "NumberLong" ? `{"$numberLong":"${match[4]}"}` : `{"$oid":"${match[4]}"}`;
    } else {
      result += `{"$date":"${match[5]}"}`;
    }
    index += match[0].length;
  }
  return result;
}

function parseMethodArgs(source: string, methodCallIndex: number): string[] | null {
  const openIndex = source.indexOf("(", methodCallIndex);
  const closeIndex = findMatchingParen(source, openIndex);
  if (closeIndex < 0 || source.slice(closeIndex + 1).trim()) return null;
  return splitTopLevel(source.slice(openIndex + 1, closeIndex));
}

interface MongoTextRange {
  from: number;
  to: number;
  text: string;
}

function splitMongoCommandTextRanges(input: string): MongoTextRange[] {
  const commands: MongoTextRange[] = [];
  for (const segment of splitMongoSemicolonSeparatedSegments(input)) {
    const parsed = parseMongoCommand(segment.text);
    if (parsed) {
      commands.push({ ...segment, text: parsed.text });
      continue;
    }

    // Mongo shell users often omit semicolons and rely on one top-level
    // command per line, so fall back to a conservative newline split.
    const softSplit = splitMongoSegmentAtSoftStarts(segment);
    if (softSplit.length > 1) {
      commands.push(...softSplit);
      continue;
    }

    commands.push(segment);
  }
  return commands;
}

function splitMongoSemicolonSeparatedSegments(input: string): MongoTextRange[] {
  const segments: MongoTextRange[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  // Respect semicolons only when they appear at the top level; JSON literals,
  // strings and comments are allowed to contain semicolons verbatim.
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] ?? "";
    const next = input[i + 1] ?? "";

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if ((char === "}" || char === "]" || char === ")") && depth > 0) depth -= 1;
    else if (char === ";" && depth === 0) {
      pushMongoSegment(segments, input, start, i);
      start = i + 1;
    }
  }

  pushMongoSegment(segments, input, start, input.length);
  return segments;
}

function splitMongoSegmentAtSoftStarts(segment: MongoTextRange): MongoTextRange[] {
  const boundaries = mongoTopLevelCommandLineStarts(segment.text);
  if (boundaries.length <= 1) return [segment];

  const segments: MongoTextRange[] = [];
  let start = boundaries[0] ?? 0;
  for (let index = 1; index < boundaries.length; index += 1) {
    const boundary = boundaries[index] ?? 0;
    const candidate = trimMongoOuterCommentRange(segment.text, start, boundary);
    // Only accept newline-based splitting when every slice is a valid command;
    // otherwise keep the original text intact and let normal parsing reject it.
    if (!candidate || !parseMongoCommand(candidate.text)) return [segment];
    segments.push({
      from: segment.from + candidate.from,
      to: segment.from + candidate.to,
      text: candidate.text,
    });
    start = boundary;
  }

  const last = trimMongoOuterCommentRange(segment.text, start, segment.text.length);
  if (!last || !parseMongoCommand(last.text)) return [segment];
  segments.push({
    from: segment.from + last.from,
    to: segment.from + last.to,
    text: last.text,
  });
  return segments;
}

function mongoTopLevelCommandLineStarts(segment: string): number[] {
  const starts: number[] = [];
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let lineStart = 0;
  let firstNonWhitespaceOnLine = -1;

  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i] ?? "";
    const next = segment[i + 1] ?? "";

    if (char === "\n") {
      if (lineComment) lineComment = false;
      lineStart = i + 1;
      firstNonWhitespaceOnLine = -1;
      continue;
    }

    if (lineComment) continue;

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      if (firstNonWhitespaceOnLine === -1 && !/\s/.test(char)) firstNonWhitespaceOnLine = i;
      quote = char;
      continue;
    }

    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if ((char === "}" || char === "]" || char === ")") && depth > 0) depth -= 1;

    if (firstNonWhitespaceOnLine === -1 && !/\s/.test(char)) {
      firstNonWhitespaceOnLine = i;
      if (depth === 0 && char !== "." && isMongoCommandLineStart(segment, i)) starts.push(i);
    }
  }

  return starts.length > 0 ? starts : [lineStart];
}

function isMongoCommandLineStart(segment: string, index: number): boolean {
  const rest = segment.slice(index);
  return /^use\b/i.test(rest) || /^db(?:\s*\.|\b)/i.test(rest);
}

function pushMongoSegment(segments: MongoTextRange[], source: string, from: number, to: number) {
  const trimmed = trimMongoOuterCommentRange(source, from, to);
  if (trimmed) segments.push(trimmed);
}

function trimMongoOuterComments(source: string): string {
  let value = source.trim();
  while (value) {
    const next = value.replace(/^(?:\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*/u, "");
    if (next === value) break;
    value = next.trimStart();
  }
  while (value) {
    const next = value.replace(/\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*$/u, "");
    if (next === value) break;
    value = next.trimEnd();
  }
  return value.trim();
}

function trimMongoOuterCommentRange(source: string, from: number, to: number): MongoTextRange | null {
  let start = from;
  let end = to;

  while (start < end) {
    const value = source.slice(start, end);
    const trimmed = value.trimStart();
    if (trimmed !== value) {
      start += value.length - trimmed.length;
      continue;
    }
    const next = value.replace(/^(?:\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*/u, "");
    if (next !== value) {
      start += value.length - next.length;
      continue;
    }
    break;
  }

  while (start < end) {
    const value = source.slice(start, end);
    const trimmed = value.trimEnd();
    if (trimmed !== value) {
      end -= value.length - trimmed.length;
      continue;
    }
    const next = value.replace(/\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*$/u, "");
    if (next !== value) {
      end -= value.length - next.length;
      continue;
    }
    break;
  }

  if (start >= end) return null;
  return {
    from: start,
    to: end,
    text: source.slice(start, end),
  };
}

function convertSingleQuotedStrings(source: string): string {
  let result = "";
  let copiedUntil = 0;
  let quote: string | null = null;
  let start = 0;
  let value = "";
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (!quote) {
      if (char === "'") {
        quote = char;
        start = i;
        value = "";
        escaped = false;
      } else if (char === '"') {
        quote = char;
      }
      continue;
    }

    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = null;
      continue;
    }

    if (escaped) {
      value += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "'") {
      result += source.slice(copiedUntil, start) + JSON.stringify(value);
      copiedUntil = i + 1;
      quote = null;
    } else {
      value += char;
    }
  }

  return quote === "'" ? source : result + source.slice(copiedUntil);
}

function parseMongoDropIndexArgument(args: string[]): string | null {
  if (args.length !== 1 || !args[0]?.trim()) return null;
  const normalized = normalizeJsonArgument(args[0]);
  if (!normalized) return null;
  const parsed = parseNormalizedJson(normalized);
  if (typeof parsed === "string") return parsed === "*" ? null : normalized;
  return isNonEmptyRecord(parsed) ? normalized : null;
}

function parseMongoDropIndexesArgument(args: string[]): string | undefined | null {
  if (args.length !== 1) return null;
  if (!args[0]?.trim()) return undefined;
  const normalized = normalizeJsonArgument(args[0]);
  if (!normalized) return null;
  const parsed = parseNormalizedJson(normalized);
  if (typeof parsed === "string") return normalized;
  if (isNonEmptyRecord(parsed)) return normalized;
  return Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === "string") ? normalized : null;
}

export function quoteUnquotedObjectKeys(source: string): string {
  let result = "";
  let quote: string | null = null;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      result += char;
      continue;
    }

    if (/[A-Za-z_$]/.test(char) && shouldQuoteObjectKey(source, i)) {
      let end = i + 1;
      while (/[\w$]/.test(source[end] || "")) end += 1;
      result += `"${source.slice(i, end)}"`;
      i = end - 1;
      continue;
    }

    result += char;
  }

  return result;
}

function shouldQuoteObjectKey(source: string, index: number): boolean {
  let before = index - 1;
  while (/\s/.test(source[before] || "")) before -= 1;
  if (source[before] !== "{" && source[before] !== ",") return false;

  let after = index + 1;
  while (/[\w$]/.test(source[after] || "")) after += 1;
  while (/\s/.test(source[after] || "")) after += 1;
  return source[after] === ":";
}

function readChainedIntegerArgument(source: string, name: string, fallback: number): number | null {
  const raw = readChainedCallArgument(source, name);
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function removeChainedMethodCall(chain: string, name: string): string {
  if (!chain.trim()) return "";
  let result = chain.trim();
  const pattern = chainedMethodCallPattern(name);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(result)) !== null) {
    const openIndex = result.indexOf("(", match.index);
    const closeIndex = findMatchingParen(result, openIndex);
    if (closeIndex < 0) break;
    result = `${result.slice(0, match.index)}${result.slice(closeIndex + 1)}`.trim();
    pattern.lastIndex = 0;
  }
  return result;
}

function readChainedCallArgument(source: string, name: string): string | undefined {
  const pattern = chainedMethodCallPattern(name);
  let match = pattern.exec(source);
  while (match) {
    const openIndex = source.indexOf("(", match.index);
    const closeIndex = findMatchingParen(source, openIndex);
    if (closeIndex >= 0) return source.slice(openIndex + 1, closeIndex);
    match = pattern.exec(source);
  }
  return undefined;
}

function hasSingleEmptyChainedCall(source: string, name: string): boolean {
  const trimmed = source.trim();
  const match = chainedMethodCallPattern(name).exec(trimmed);
  if (!match || match.index !== 0) return false;
  const openIndex = trimmed.indexOf("(", match.index);
  const closeIndex = findMatchingParen(trimmed, openIndex);
  return closeIndex >= 0 && !trimmed.slice(openIndex + 1, closeIndex).trim() && !trimmed.slice(closeIndex + 1).trim();
}

function findChainedMethodCallIndex(source: string, name: string): number {
  return chainedMethodCallPattern(name).exec(source)?.index ?? -1;
}

function chainedMethodCallPattern(name: string): RegExp {
  return new RegExp(`\\.\\s*${escapeRegExp(name)}\\s*\\(`, "g");
}

function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") quote = char;
    else if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }

  parts.push(source.slice(start).trim());
  return parts;
}

function findMatchingParen(source: string, openIndex: number): number {
  if (source[openIndex] !== "(") return -1;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseNormalizedJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0;
}

function isEmptyJsonObject(json: string): boolean {
  const parsed = parseNormalizedJson(json);
  return isRecord(parsed) && Object.keys(parsed).length === 0;
}

function mongoDropIndexesRequiresDangerous(command: MongoWriteCommand): boolean {
  if (command.kind !== "dropIndexes") return false;
  if (!command.indexes) return true;
  const parsed = parseNormalizedJson(command.indexes);
  if (parsed === "*") return true;
  return Array.isArray(parsed) && parsed.length > 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toCellValue(value: unknown): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return mongoDocumentIdForGrid(value);
}
