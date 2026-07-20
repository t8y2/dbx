import type { QueryResult } from "@/types/database";
import { mongoDocumentIdForGrid } from "@/lib/mongo/mongoDocumentValues";
import {
  chainedMethodCallPattern,
  describeMongoCommandParseFailure,
  findChainedMethodCallIndex,
  findMatchingParen,
  MONGO_SHELL_COMMAND_HINT,
  normalizeJsonArgument,
  parseCollectionMethodTarget,
  parseMongoAggregateCommand,
  quoteUnquotedObjectKeys,
  splitTopLevel,
  type MongoAggregateCommand,
} from "@dbx-app/mongo-shell";

export type { MongoAggregateCommand };
export { describeMongoCommandParseFailure, MONGO_SHELL_COMMAND_HINT, parseMongoAggregateCommand, quoteUnquotedObjectKeys };

export interface MongoFindCommand {
  collection: string;
  filter: string;
  projection?: string;
  skip: number;
  limit: number;
  sort?: string;
}

export interface MongoFindOneCommand {
  collection: string;
  filter: string;
  projection?: string;
  options?: string;
}

export interface MongoCountDocumentsCommand {
  collection: string;
  filter: string;
  mode: "accurate" | "legacy";
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

export interface MongoDistinctCommand {
  collection: string;
  field: string;
  filter?: string;
}

type MongoWriteKind = "insert" | "update" | "delete" | "createIndex" | "dropIndex" | "dropIndexes" | "dropCollection" | "findOneAndUpdate" | "findOneAndReplace" | "findOneAndDelete";

export type MongoCommand =
  | ({ kind: "find" } & MongoFindCommand)
  | ({ kind: "findOne" } & MongoFindOneCommand)
  | MongoVersionCommand
  | ({ kind: "countDocuments" } & MongoCountDocumentsCommand)
  | ({ kind: "aggregate" } & MongoAggregateCommand)
  | ({ kind: "distinct" } & MongoDistinctCommand)
  | ({ kind: "getIndexes" } & MongoGetIndexesCommand)
  | ({ kind: "collectionStats" } & MongoCollectionStatsCommand)
  | ({ kind: "use" } & MongoUseCommand)
  | { kind: "insert"; collection: string; docsJson: string }
  | { kind: "update"; collection: string; filter: string; update: string; options?: string; many: boolean }
  | { kind: "delete"; collection: string; filter: string; many: boolean }
  | { kind: "createIndex"; collection: string; keys: string; options?: string }
  | { kind: "dropIndex"; collection: string; index: string }
  | { kind: "dropIndexes"; collection: string; indexes?: string }
  | { kind: "dropCollection"; collection: string }
  | { kind: "findOneAndUpdate"; collection: string; filter: string; update: string; options?: string }
  | { kind: "findOneAndReplace"; collection: string; filter: string; replacement: string; options?: string }
  | { kind: "findOneAndDelete"; collection: string; filter: string; options?: string };

export type MongoWriteCommand = Extract<MongoCommand, { kind: MongoWriteKind }>;

export function normalizeRustMongoCommand(raw: Record<string, unknown>): MongoCommand {
  const command = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null)) as Record<string, any>;
  if (command.kind === "countDocuments") {
    const { accurate, ...rest } = command;
    return { ...rest, kind: "countDocuments", mode: accurate ? "accurate" : "legacy" } as MongoCommand;
  }
  if (command.kind === "dropIndexes") {
    const { single, indexes, ...rest } = command;
    if (single) return { ...rest, kind: "dropIndex", index: indexes } as MongoCommand;
    return { ...rest, kind: "dropIndexes", ...(indexes ? { indexes } : {}) } as MongoCommand;
  }
  return command as MongoCommand;
}

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

export function parseMongoFindOneCommand(input: string): MongoFindOneCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  const target = parseCollectionMethodTarget(source, "findOne");
  if (!target) return null;

  const args = parseMethodArgs(source, target.methodCallIndex);
  if (!args) return null;
  if (args.length > 3 && args.slice(3).some((arg) => arg.trim())) return null;

  const filter = normalizeJsonArgument(args[0] || "{}");
  if (!filter) return null;

  let projection: string | undefined;
  if (args[1]?.trim()) {
    const parsedProjection = normalizeJsonArgument(args[1]);
    if (!parsedProjection) return null;
    projection = parsedProjection;
  }

  const options = args[2]?.trim() ? normalizeJsonArgument(args[2]) : undefined;
  if (args[2]?.trim() && !options) return null;

  return {
    collection: target.collection,
    filter,
    ...(projection ? { projection } : {}),
    ...(options ? { options } : {}),
  };
}

export interface MongoFindOneAndUpdateCommand {
  collection: string;
  filter: string;
  update: string;
  options?: string;
}

export interface MongoFindOneAndReplaceCommand {
  collection: string;
  filter: string;
  replacement: string;
  options?: string;
}

export interface MongoFindOneAndDeleteCommand {
  collection: string;
  filter: string;
  options?: string;
}

export function parseMongoFindOneAndUpdateCommand(input: string): MongoFindOneAndUpdateCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  const target = parseCollectionMethodTarget(source, "findOneAndUpdate");
  if (!target) return null;

  const args = parseMethodArgs(source, target.methodCallIndex);
  if (!args || args.length < 2 || args.length > 3) return null;
  const filter = normalizeJsonArgument(args[0] || "{}");
  const update = normalizeJsonArgument(args[1]);
  if (!filter || !update) return null;
  const options = args[2]?.trim() ? normalizeJsonArgument(args[2]) : undefined;
  if (args[2]?.trim() && !options) return null;

  return { collection: target.collection, filter, update, ...(options ? { options } : {}) };
}

export function parseMongoFindOneAndReplaceCommand(input: string): MongoFindOneAndReplaceCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  const target = parseCollectionMethodTarget(source, "findOneAndReplace");
  if (!target) return null;

  const args = parseMethodArgs(source, target.methodCallIndex);
  if (!args || args.length < 2 || args.length > 3) return null;
  const filter = normalizeJsonArgument(args[0] || "{}");
  const replacement = normalizeJsonArgument(args[1]);
  if (!filter || !replacement) return null;
  const options = args[2]?.trim() ? normalizeJsonArgument(args[2]) : undefined;
  if (args[2]?.trim() && !options) return null;

  return { collection: target.collection, filter, replacement, ...(options ? { options } : {}) };
}

export function parseMongoFindOneAndDeleteCommand(input: string): MongoFindOneAndDeleteCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  const target = parseCollectionMethodTarget(source, "findOneAndDelete");
  if (!target) return null;

  const args = parseMethodArgs(source, target.methodCallIndex);
  if (!args || args.length < 1 || args.length > 2) return null;
  const filter = normalizeJsonArgument(args[0] || "{}");
  if (!filter) return null;
  const options = args[1]?.trim() ? normalizeJsonArgument(args[1]) : undefined;
  if (args[1]?.trim() && !options) return null;

  return { collection: target.collection, filter, ...(options ? { options } : {}) };
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

export function parseMongoDistinctCommand(input: string): MongoDistinctCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  const target = parseCollectionMethodTarget(source, "distinct");
  if (!target) return null;

  const openIndex = source.indexOf("(", target.methodCallIndex);
  const closeIndex = findMatchingParen(source, openIndex);
  if (closeIndex < 0 || source.slice(closeIndex + 1).trim()) return null;

  const args = splitTopLevel(source.slice(openIndex + 1, closeIndex));
  if (args.length < 1 || args.length > 2) return null;

  const fieldJson = normalizeJsonArgument(args[0] ?? "");
  if (!fieldJson) return null;
  let field: unknown;
  try {
    field = JSON.parse(fieldJson);
  } catch {
    return null;
  }
  if (typeof field !== "string" || !field.trim()) return null;

  if (args.length === 1) return { collection: target.collection, field };

  const filter = normalizeJsonArgument(args[1] ?? "");
  if (!filter) return null;
  return { collection: target.collection, field, filter };
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

  const insert = parseCollectionMethodTarget(source, "insert");
  if (insert) {
    const args = parseMethodArgs(source, insert.methodCallIndex);
    if (!args || args.length !== 1 || !args[0]?.trim()) return null;
    const docs = normalizeJsonArgument(args[0]);
    if (!docs) return null;
    const value = JSON.parse(docs);
    return value !== null && typeof value === "object" ? { kind: "insert", collection: insert.collection, docsJson: docs } : null;
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
      const findOne = parseMongoFindOneCommand(source);
      return findOne ? { kind: "findOne", ...findOne } : null;
    },
    (source) => {
      const findOneAndUpdate = parseMongoFindOneAndUpdateCommand(source);
      return findOneAndUpdate ? { kind: "findOneAndUpdate", ...findOneAndUpdate } : null;
    },
    (source) => {
      const findOneAndReplace = parseMongoFindOneAndReplaceCommand(source);
      return findOneAndReplace ? { kind: "findOneAndReplace", ...findOneAndReplace } : null;
    },
    (source) => {
      const findOneAndDelete = parseMongoFindOneAndDeleteCommand(source);
      return findOneAndDelete ? { kind: "findOneAndDelete", ...findOneAndDelete } : null;
    },
    (source) => {
      const aggregate = parseMongoAggregateCommand(source);
      return aggregate ? { kind: "aggregate", ...aggregate } : null;
    },
    (source) => {
      const distinct = parseMongoDistinctCommand(source);
      return distinct ? { kind: "distinct", ...distinct } : null;
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
      reason: "MCP MongoDB execution is read-only under the current DBX policy.",
    };
  }
  const filter = mongoWriteFilter(command);
  const highRisk = filter !== null ? mongoFilterIsEffectivelyUnbounded(filter) : command.kind !== "insert";
  if (!options.allowDangerous && highRisk) {
    return {
      allowed: false,
      reason: `MongoDB ${command.kind} requires high-risk operations to be enabled in DBX MCP settings.`,
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
      reason: `MongoDB aggregate stage "${writeStage}" is blocked by the current DBX MCP read-only policy.`,
    };
  }
  if (!options.allowDangerous) {
    return {
      allowed: false,
      reason: `MongoDB aggregate stage "${writeStage}" requires high-risk operations to be enabled in DBX MCP settings.`,
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

export function mongoDistinctToQueryResult(field: string, values: unknown[], executionTimeMs: number): QueryResult {
  return {
    columns: [field],
    rows: values.map((value) => [toCellValue(value)]),
    affected_rows: values.length,
    execution_time_ms: Math.max(0, Math.round(executionTimeMs)),
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

    // `--` is a line comment too: the editor runs Mongo through its SQL language
    // mode, which comments with `--` alongside the shell's native `//`.
    if ((char === "/" && next === "/") || (char === "-" && next === "-")) {
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

    // `--` is a line comment too: the editor runs Mongo through its SQL language
    // mode, which comments with `--` alongside the shell's native `//`.
    if ((char === "/" && next === "/") || (char === "-" && next === "-")) {
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

/**
 * Index just past the last code character in `source[start, end)`, treating
 * quoted strings and `//` / `--` / block comments as non-code. Trailing
 * whitespace and comments sit after the returned index; a comment marker inside
 * a string value (`{ note: "a--b" }`) stays code, so it is never mistaken for a
 * trailing comment and truncated away.
 */
function mongoCommentAwareBodyEnd(source: string, start: number, end: number): number {
  let bodyEnd = start;
  let quote: string | null = null;
  let i = start;
  while (i < end) {
    const char = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (quote) {
      if (char === "\\") {
        i += 2;
        bodyEnd = Math.min(i, end);
        continue;
      }
      if (char === quote) quote = null;
      i += 1;
      bodyEnd = i;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      i += 1;
      bodyEnd = i;
      continue;
    }
    if ((char === "/" && next === "/") || (char === "-" && next === "-")) {
      const newline = source.indexOf("\n", i + 2);
      i = newline < 0 || newline >= end ? end : newline;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close < 0 || close + 2 > end ? end : close + 2;
      continue;
    }
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    i += 1;
    bodyEnd = i;
  }
  return bodyEnd;
}

function trimMongoOuterComments(source: string): string {
  let value = source.trim();
  // Leading comments sit before any string, so a simple regex is safe here.
  while (value) {
    const next = value.replace(/^(?:(?:\/\/|--)[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*/u, "");
    if (next === value) break;
    value = next.trimStart();
  }
  // Trailing comments need string awareness so a comment marker inside a string
  // value near the end is not truncated as if it began a comment.
  return value.slice(0, mongoCommentAwareBodyEnd(value, 0, value.length)).trim();
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
    const next = value.replace(/^(?:(?:\/\/|--)[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*/u, "");
    if (next !== value) {
      start += value.length - next.length;
      continue;
    }
    break;
  }

  // Trailing comments are found with string awareness (see mongoCommentAwareBodyEnd)
  // so a `--`/`//` inside a trailing string value is not treated as a comment.
  end = mongoCommentAwareBodyEnd(source, start, end);
  while (end > start && /\s/.test(source[end - 1] ?? "")) end -= 1;

  if (start >= end) return null;
  return {
    from: start,
    to: end,
    text: source.slice(start, end),
  };
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

function mongoWriteFilter(command: MongoWriteCommand): string | null {
  switch (command.kind) {
    case "update":
    case "delete":
    case "findOneAndUpdate":
    case "findOneAndReplace":
    case "findOneAndDelete":
      return command.filter;
    default:
      return null;
  }
}

function mongoFilterIsEffectivelyUnbounded(json: string): boolean {
  const parsed = parseNormalizedJson(json);
  return !isRecord(parsed) || mongoFilterContainsOpaqueLogic(parsed) || mongoFilterObjectIsUnbounded(parsed);
}

function mongoFilterContainsOpaqueLogic(filter: Record<string, unknown>): boolean {
  return Object.entries(filter).some(([key, value]) => {
    if (key === "$comment") return false;
    if (key === "$where" || key === "$expr" || key === "$nor") return true;
    if (key === "$and" || key === "$or") {
      if (!Array.isArray(value) || value.length === 0 || value.some((clause) => !isRecord(clause))) return true;
      if (value.some((clause) => mongoFilterContainsOpaqueLogic(clause as Record<string, unknown>))) return true;
      if (key === "$or" && value.some((clause) => isRecord(clause) && Object.prototype.hasOwnProperty.call(clause, "$and"))) return true;
      return key === "$or" && mongoOrHasComplementaryFieldClauses(value);
    }
    return key.startsWith("$") || mongoFieldPredicateContainsOpaqueLogic(value);
  });
}

const MONGO_SAFE_FIELD_OPERATORS = new Set(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$exists"]);

function mongoFieldPredicateContainsOpaqueLogic(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (mongoExtendedJsonScalarLiteralIsValid(value)) return false;
  const keys = Object.keys(value);
  if (!keys.some((key) => key.startsWith("$"))) return false;
  return keys.some((key) => !key.startsWith("$") || !MONGO_SAFE_FIELD_OPERATORS.has(key));
}

interface MongoPureFieldPredicate {
  field: string;
  operator: string;
  operand: unknown;
}

function mongoOrHasComplementaryFieldClauses(clauses: unknown[]): boolean {
  const predicates = clauses.map(mongoPureFieldPredicate).filter((value): value is MongoPureFieldPredicate => value !== null);
  return predicates.some((predicate, index) => predicates.slice(index + 1).some((other) => mongoFieldPredicatesAreComplementary(predicate, other)));
}

function mongoPureFieldPredicate(value: unknown): MongoPureFieldPredicate | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).filter(([key]) => key !== "$comment");
  if (entries.length !== 1) return null;
  const [field, predicate] = entries[0]!;
  if (field === "$and" && Array.isArray(predicate)) {
    const boundedClauses = predicate.filter((clause) => isRecord(clause) && !mongoFilterObjectIsUnbounded(clause));
    return boundedClauses.length === 1 ? mongoPureFieldPredicate(boundedClauses[0]) : null;
  }
  if (field === "$or" && Array.isArray(predicate) && predicate.length === 1) {
    return mongoPureFieldPredicate(predicate[0]);
  }
  if (field.startsWith("$")) return null;
  if (!isRecord(predicate) || mongoExtendedJsonScalarLiteralIsValid(predicate) || !Object.keys(predicate).some((key) => key.startsWith("$"))) {
    return { field, operator: "$eq", operand: predicate };
  }
  const operators = Object.entries(predicate);
  if (operators.length !== 1 || !MONGO_SAFE_FIELD_OPERATORS.has(operators[0]![0])) return null;
  return { field, operator: operators[0]![0], operand: operators[0]![1] };
}

function mongoFieldPredicatesAreComplementary(left: MongoPureFieldPredicate, right: MongoPureFieldPredicate): boolean {
  if (left.field !== right.field) return false;
  if (left.operator === "$exists" && right.operator === "$exists") {
    return typeof left.operand === "boolean" && typeof right.operand === "boolean" && left.operand !== right.operand;
  }
  const pair = `${left.operator}/${right.operator}`;
  if (pair === "$in/$nin" || pair === "$nin/$in") return mongoJsonSetsEqual(left.operand, right.operand);
  if (!["$eq/$ne", "$ne/$eq", "$gt/$lte", "$lte/$gt", "$gte/$lt", "$lt/$gte"].includes(pair)) return false;
  return mongoJsonValuesEqual(left.operand, right.operand);
}

function mongoJsonSetsEqual(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  return left.every((value) => right.some((other) => mongoJsonValuesEqual(value, other))) && right.every((value) => left.some((other) => mongoJsonValuesEqual(value, other)));
}

function mongoJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => mongoJsonValuesEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && mongoJsonValuesEqual(left[key], right[key]));
}

function mongoExtendedJsonScalarLiteralIsValid(value: Record<string, unknown>): boolean {
  const entries = Object.entries(value);
  if (entries.length !== 1) return false;
  const [key, scalar] = entries[0]!;
  if (key === "$oid") return typeof scalar === "string" && /^[0-9a-fA-F]{24}$/.test(scalar);
  if (key === "$numberLong") return typeof scalar === "string" && mongoInt64StringIsValid(scalar);
  return key === "$date" && typeof scalar === "string" && mongoRfc3339DateIsValid(scalar);
}

function mongoInt64StringIsValid(value: string): boolean {
  if (!/^-?\d+$/.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed >= -9223372036854775808n && parsed <= 9223372036854775807n;
  } catch {
    return false;
  }
}

function mongoRfc3339DateIsValid(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day >= 1 && day <= daysInMonth && Number(hourText) <= 23 && Number(minuteText) <= 59 && Number(secondText) <= 59 && (offsetHourText === undefined || (Number(offsetHourText) <= 23 && Number(offsetMinuteText) <= 59));
}

function mongoFilterObjectIsUnbounded(filter: Record<string, unknown>): boolean {
  const entries = Object.entries(filter);
  if (entries.length === 0) return true;
  if (entries.some(([key]) => key === "$where" || key === "$expr")) return true;

  return entries.every(([key, value]) => {
    if (key === "$comment") return true;
    if (key === "$and") {
      return !Array.isArray(value) || value.every((clause) => !isRecord(clause) || mongoFilterObjectIsUnbounded(clause));
    }
    if (key === "$or") {
      return !Array.isArray(value) || value.length === 0 || value.some((clause) => !isRecord(clause) || mongoFilterObjectIsUnbounded(clause));
    }
    if (key === "$nor") return true;
    if (mongoFieldPredicateIsEmptyNin(value)) return true;
    if (key === "_id" && mongoFieldPredicateIsExistsTrue(value)) return true;
    return key.startsWith("$");
  });
}

function mongoFieldPredicateIsEmptyNin(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 1 && Array.isArray(value.$nin) && value.$nin.length === 0;
}

function mongoFieldPredicateIsExistsTrue(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 1 && value.$exists === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toCellValue(value: unknown): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return mongoDocumentIdForGrid(value);
}
