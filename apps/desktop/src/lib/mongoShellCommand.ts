import type { QueryResult } from "@/types/database";

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

export type MongoWriteCommand =
  | { kind: "insert"; collection: string; docsJson: string }
  | { kind: "update"; collection: string; filter: string; update: string; many: boolean }
  | { kind: "delete"; collection: string; filter: string; many: boolean }
  | { kind: "createIndex"; collection: string; keys: string; options?: string }
  | { kind: "dropIndex"; collection: string; index: string }
  | { kind: "dropIndexes"; collection: string; indexes?: string };

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

export function parseMongoCountDocumentsCommand(input: string): MongoCountDocumentsCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  const target = parseCollectionMethodTarget(source, "countDocuments");
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
    if (!args || args.length !== 2) return null;
    const filter = normalizeJsonArgument(args[0]);
    const update = normalizeJsonArgument(args[1]);
    if (!filter || !update) return null;
    return { kind: "update", collection: target.collection, filter, update, many: method === "updateMany" };
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

  return null;
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
  const preprocessed = quoteUnquotedObjectKeys(convertSingleQuotedStrings(trimmed.replace(/ObjectId\s*\(\s*["']([^"']+)["']\s*\)/g, '{"$oid":"$1"}')));
  try {
    JSON.parse(preprocessed);
    return preprocessed;
  } catch {
    return null;
  }
}

function parseMethodArgs(source: string, methodCallIndex: number): string[] | null {
  const openIndex = source.indexOf("(", methodCallIndex);
  const closeIndex = findMatchingParen(source, openIndex);
  if (closeIndex < 0 || source.slice(closeIndex + 1).trim()) return null;
  return splitTopLevel(source.slice(openIndex + 1, closeIndex));
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
  return JSON.stringify(value);
}
