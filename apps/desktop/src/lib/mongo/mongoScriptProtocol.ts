import { mongoPipelineOutput, parseMongoPipeline } from "./mongoAggregation";

export interface MongoScriptRequest {
  id: number;
  method: string;
  collection: string;
  args: unknown[];
}
export type MongoScriptOperation =
  | { kind: "find"; collection: string; filter: string; projection: string; sort: string; skip: number; limit: number }
  | { kind: "aggregate"; collection: string; pipeline: string; limit: number }
  | { kind: "count"; collection: string; filter: string }
  | { kind: "write"; command: string; targetDatabase: string };
function object(value: unknown, fallback = false): Record<string, unknown> {
  if (value === undefined && fallback) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON document");
  return value as Record<string, unknown>;
}
function bounded(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("Invalid cursor limit/skip");
  return value;
}
/** JSON must never silently drop values or coerce BSON inputs before review. */
export function assertMongoScriptJson(input: unknown): void {
  const ancestors = new Set<object>();
  let nodes = 0;
  let characters = 0;
  function visit(value: unknown, depth: number): void {
    if (++nodes > 100000 || depth > 64) throw new Error("Script request exceeds JSON depth/node limits");
    if (typeof value === "string") {
      characters += value.length;
      if (characters > 2 * 1024 * 1024) throw new Error("Script request exceeds 2 MiB");
      return;
    }
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error("Use Extended JSON for non-finite or unsafe numeric values");
      return;
    }
    if (typeof value !== "object") throw new Error("Script database arguments must be JSON; use Extended JSON for BSON values");
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error("Script database arguments must be plain JSON; Date, RegExp, Map and Set require Extended JSON");
    if (ancestors.has(value)) throw new Error("Script database arguments cannot contain circular references");
    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    if (array && (value.length > 100000 || keys.length !== value.length + 1)) throw new Error("Sparse or decorated arrays are not JSON");
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string") throw new Error("Symbol properties are not JSON");
      if (array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error("Decorated arrays are not JSON");
      const property = Object.getOwnPropertyDescriptor(value, key)!;
      if (!property.enumerable || !("value" in property)) throw new Error("Hidden properties and accessors are not JSON");
      characters += key.length;
      if (characters > 2 * 1024 * 1024) throw new Error("Script request exceeds 2 MiB");
      visit(property.value, depth + 1);
    }
    ancestors.delete(value);
  }
  visit(input, 0);
}
function fieldPath(path: string): void {
  if (!path || path.includes("\0") || path.split(".").some((part) => !part || part.startsWith("$") || /^\d+$/.test(part))) throw new Error("Use ordinary field paths for find projection/sort; use aggregate for advanced expressions");
}
function findProjection(value: unknown): Record<string, unknown> {
  const projection = object(value, true);
  let inclusion = false;
  let exclusion = false;
  const paths = Object.keys(projection);
  for (const [path, flag] of Object.entries(projection)) {
    fieldPath(path);
    if (flag !== 0 && flag !== 1 && flag !== false && flag !== true) throw new Error("find supports only 0/1/boolean projection; use aggregate for advanced projection");
    if (path !== "_id") {
      inclusion ||= flag === 1 || flag === true;
      exclusion ||= flag === 0 || flag === false;
    }
    if (paths.some((other) => other !== path && other.startsWith(path + "."))) throw new Error("Projection paths must not overlap");
  }
  if (inclusion && exclusion) throw new Error("Cannot mix inclusion and exclusion projection except for _id");
  return projection;
}
function findSort(value: unknown): Record<string, unknown> {
  const sort = object(value, true);
  for (const [path, direction] of Object.entries(sort)) {
    fieldPath(path);
    if (direction !== 1 && direction !== -1) throw new Error("find sort requires 1 or -1; use aggregate for advanced sorting");
  }
  return sort;
}
function readFilter(value: unknown): Record<string, unknown> {
  const filter = object(value, true);
  function query(document: Record<string, unknown>): void {
    for (const [key, condition] of Object.entries(document)) {
      if (["$where", "$near", "$nearSphere", "$natural", "$isolated", "$atomic"].includes(key)) throw new Error("Unsupported script find/count filter operator: " + key + "; use an explicit aggregation pipeline");
      if (key === "$and" || key === "$or" || key === "$nor") {
        if (!Array.isArray(condition)) throw new Error("Logical filter operators require arrays");
        condition.forEach((item) => query(object(item)));
      } else if (key === "$not" || key === "$elemMatch") query(object(condition));
      else if (!key.startsWith("$") && condition && typeof condition === "object" && !Array.isArray(condition) && Object.keys(condition).some((name) => name.startsWith("$"))) query(condition as Record<string, unknown>);
    }
  }
  query(filter);
  return filter;
}
/** Treat every message from the script sandbox as untrusted. */
export function mongoScriptOperation(input: unknown, database: string): { request: MongoScriptRequest; operation: MongoScriptOperation } {
  assertMongoScriptJson(input);
  const message = object(input);
  if (!Number.isSafeInteger(message.id) || (message.id as number) < 1 || typeof message.method !== "string" || typeof message.collection !== "string" || !message.collection || message.collection.includes("\0") || !Array.isArray(message.args)) throw new Error("Invalid script request");
  if (JSON.stringify(message).length > 2 * 1024 * 1024) throw new Error("Script request exceeds 2 MiB");
  const request = message as unknown as MongoScriptRequest;
  const { collection, method, args } = request;
  let operation: MongoScriptOperation;
  const json = JSON.stringify;
  if (method === "find") {
    const options = object(args[2], true);
    if (Object.keys(options).some((key) => !["limit", "skip", "sort"].includes(key))) throw new Error("Unsupported find cursor option");
    operation = {
      kind: "find",
      collection,
      filter: json(readFilter(args[0])),
      projection: json(findProjection(args[1])),
      sort: json(findSort(options.sort)),
      skip: bounded(options.skip, 0, 0, 1_000_000),
      limit: bounded(options.limit, 100, 1, 10000),
    };
  } else if (method === "countDocuments") {
    operation = { kind: "count", collection, filter: json(readFilter(args[0])) };
  } else if (method === "aggregate") {
    const pipeline = parseMongoPipeline(json(args[0]));
    const output = mongoPipelineOutput(pipeline, database);
    operation = output ? { kind: "write", command: json({ aggregate: collection, pipeline, cursor: {}, maxTimeMS: 60000 }), targetDatabase: output.database } : { kind: "aggregate", collection, pipeline: json(pipeline), limit: bounded(args[1], 100, 1, 10000) };
  } else {
    let command: Record<string, unknown>;
    if (method === "insertOne" || method === "insertMany") {
      const documents = method === "insertOne" ? [object(args[0])] : args[0];
      if (!Array.isArray(documents) || documents.length < 1 || documents.length > 1000) throw new Error("insertMany requires 1–1000 documents");
      documents.forEach((doc) => object(doc));
      command = { insert: collection, documents, ordered: true };
    } else if (["updateOne", "updateMany", "replaceOne"].includes(method)) {
      const update = object(args[1]);
      const options = object(args[2], true);
      if (Object.keys(options).some((key) => key !== "upsert") || (options.upsert !== undefined && typeof options.upsert !== "boolean")) throw new Error("Only the boolean upsert option is supported");
      if (!Object.keys(update).length || (method === "replaceOne" ? Object.keys(update).some((key) => key.startsWith("$")) : !Object.keys(update).every((key) => key.startsWith("$")))) throw new Error("Use replacement documents for replaceOne and update operators for updateOne/updateMany");
      command = { update: collection, updates: [{ q: object(args[0]), u: update, multi: method === "updateMany", upsert: options.upsert === true }], ordered: true };
    } else if (method === "deleteOne" || method === "deleteMany") {
      command = { delete: collection, deletes: [{ q: object(args[0]), limit: method === "deleteOne" ? 1 : 0 }], ordered: true };
    } else throw new Error("Unsupported script database method: " + method);
    operation = { kind: "write", command: json(command), targetDatabase: database };
  }
  return { request, operation };
}
