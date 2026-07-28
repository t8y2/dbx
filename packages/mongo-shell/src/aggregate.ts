/**
 * Thin `db.collection.aggregate(pipeline[, options])` parse + diagnostics.
 * JSON preprocessing lives in ./json.ts — do not re-copy helpers here.
 */

import {
  findMatchingParen,
  hasUnclosedMongoDelimiters,
  normalizeJsonArgument,
  parseCollectionMethodTarget,
  parseMongoObjectArgument,
  splitTopLevel,
  trimMongoOuterComments,
} from "./json.js";

export interface MongoAggregateCommand {
  collection: string;
  pipeline: string;
  /** Optional second argument to `aggregate(pipeline, options)`, e.g. `{explain: true}`. */
  options?: string;
}

/** Shared unsupported-command hint (Rust SQL backstop copies this wording). */
export const MONGO_SHELL_COMMAND_HINT =
  "Use MongoDB shell-style commands, for example: db.collection.find({}).limit(100), " +
  "db.collection.aggregate([]), db.collection.aggregate([], { explain: true }), " +
  'db.version(), db.collection.countDocuments({}), db.collection.distinct("field"), ' +
  "db.collection.getIndexes(), db.collection.createIndex({...}), or db.collection.insertOne({...}).";

const PIPELINE_MUST_BE_ARRAY =
  "MongoDB aggregate pipeline must be a JSON array (for example [{ $match: {} }]).";
const OPTIONS_MUST_BE_OBJECT =
  "MongoDB aggregate options must be a JSON object (for example { explain: true }).";
const UNCLOSED_DELIMITERS =
  "MongoDB command has unclosed parentheses, brackets, braces, or strings.";
const UNSUPPORTED_CHAINING =
  "Unsupported MongoDB aggregate form. Use db.collection.aggregate(pipeline) or " +
  "db.collection.aggregate(pipeline, options). Chaining (for example .limit()) is not supported.";
const EXPECTS_PIPELINE_OR_OPTIONS =
  "MongoDB aggregate expects aggregate(pipeline) or aggregate(pipeline, options).";

type AggregateParseResult =
  | { ok: true; command: MongoAggregateCommand }
  | { ok: false; reason: string };

export function parseMongoAggregateCommand(input: string): MongoAggregateCommand | null {
  const source = input.trim().replace(/;$/, "").trim();
  const parsed = tryParseMongoAggregateCommand(source);
  return parsed?.ok ? parsed.command : null;
}

/**
 * Diagnose shell parse failures so callers do not fall through to a generic SQL rejection.
 * Aggregate-shaped input gets specific reasons; everything else gets {@link MONGO_SHELL_COMMAND_HINT}.
 */
export function describeMongoCommandParseFailure(input: string): string {
  const source = trimMongoOuterComments(input).trim().replace(/;$/, "").trim();
  if (!source) return "Empty MongoDB command.";
  if (hasUnclosedMongoDelimiters(source)) return UNCLOSED_DELIMITERS;
  const aggregate = tryParseMongoAggregateCommand(source);
  if (aggregate && !aggregate.ok) return aggregate.reason;
  return MONGO_SHELL_COMMAND_HINT;
}

function tryParseMongoAggregateCommand(source: string): AggregateParseResult | null {
  const target = parseCollectionMethodTarget(source, "aggregate");
  if (!target) return null;

  const openIndex = source.indexOf("(", target.methodCallIndex);
  const closeIndex = findMatchingParen(source, openIndex);
  if (closeIndex < 0) return { ok: false, reason: UNCLOSED_DELIMITERS };
  if (source.slice(closeIndex + 1).trim()) return { ok: false, reason: UNSUPPORTED_CHAINING };

  const args = splitTopLevel(source.slice(openIndex + 1, closeIndex));
  if (args.length < 1 || args.length > 2) return { ok: false, reason: EXPECTS_PIPELINE_OR_OPTIONS };
  if (args.length === 2 && !args[1]?.trim()) return { ok: false, reason: OPTIONS_MUST_BE_OBJECT };

  const pipeline = normalizeJsonArgument(args[0] ?? "");
  if (!pipeline) return { ok: false, reason: PIPELINE_MUST_BE_ARRAY };
  try {
    if (!Array.isArray(JSON.parse(pipeline))) return { ok: false, reason: PIPELINE_MUST_BE_ARRAY };
  } catch {
    return { ok: false, reason: PIPELINE_MUST_BE_ARRAY };
  }

  if (args.length === 2) {
    const options = parseMongoObjectArgument(args[1]);
    if (!options) return { ok: false, reason: OPTIONS_MUST_BE_OBJECT };
    return { ok: true, command: { collection: target.collection, pipeline, options } };
  }

  return { ok: true, command: { collection: target.collection, pipeline } };
}
