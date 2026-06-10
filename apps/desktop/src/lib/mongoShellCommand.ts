import type { QueryResult } from "@/types/database";

export interface MongoFindCommand {
  collection: string;
  filter: string;
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

export type MongoWriteCommand = { kind: "insert"; collection: string; docsJson: string } | { kind: "update"; collection: string; filter: string; update: string; many: boolean } | { kind: "delete"; collection: string; filter: string; many: boolean };

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
  const filter = normalizeJsonArgument(findArgs[0] || "{}");
  if (!filter) return null;

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

  return null;
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
  const direct = new RegExp(`^db\\.([A-Za-z_$][\\w$]*)\\.${escapedMethod}\\s*\\(`).exec(source);
  if (direct) {
    return {
      collection: direct[1],
      methodCallIndex: source.indexOf(`.${method}`, direct[0].length - `.${method}(`.length),
    };
  }

  const getCollection = new RegExp(`^db\\.getCollection\\s*\\(\\s*(["'])(.*?)\\1\\s*\\)\\.${escapedMethod}\\s*\\(`).exec(source);
  if (getCollection) {
    return {
      collection: getCollection[2],
      methodCallIndex: source.indexOf(`.${method}`, getCollection[0].length - `.${method}(`.length),
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

function quoteUnquotedObjectKeys(source: string): string {
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
  const call = `.${name}`;
  let index = source.indexOf(call);
  while (index >= 0) {
    const afterName = index + call.length;
    const openIndex = skipWhitespace(source, afterName);
    if (source[openIndex] === "(") {
      const closeIndex = findMatchingParen(source, openIndex);
      if (closeIndex >= 0) return source.slice(openIndex + 1, closeIndex);
    }
    index = source.indexOf(call, afterName);
  }
  return undefined;
}

function skipWhitespace(source: string, index: number) {
  let cursor = index;
  while (/\s/.test(source[cursor] || "")) cursor += 1;
  return cursor;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toCellValue(value: unknown): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}
