/**
 * Records the db calls a Mongo shell script makes. Runs inside the script
 * worker; scripts must pass `checkMongoScript` (mongoScriptCheck.ts) first.
 */

export type MongoScriptExpansion = { ok: true; commands: string[] } | { ok: false; error: string };

/** Upper bound on recorded commands, so a runaway loop fails instead of flooding the server. */
export const MONGO_SCRIPT_MAX_COMMANDS = 1000;

export const MONGO_SCRIPT_RESULTS_UNAVAILABLE = "Scripts cannot read query results: each db call must be a statement on its own, not a value";

const DATABASE_METHODS = new Set(["version", "stats", "serverStatus", "createCollection", "dropDatabase", "createUser", "runCommand"]);

class MongoShellLiteral {
  constructor(readonly text: string) {}
}

interface RecordedCall {
  database?: string;
  collection?: string;
  method: string;
  args: unknown[];
  chain: { method: string; args: unknown[] }[];
}

/**
 * Runs a checked script and returns the shell commands its `db` calls make.
 * Call `checkMongoScript` first; this runs the script's code as-is.
 */
export function recordMongoScriptCommands(script: string): MongoScriptExpansion {
  const calls: RecordedCall[] = [];

  const record = (call: RecordedCall) => {
    if (calls.length >= MONGO_SCRIPT_MAX_COMMANDS) throw new Error(`Script made more than ${MONGO_SCRIPT_MAX_COMMANDS} database calls.`);
    calls.push(call);
    const chain: object = new Proxy(
      {},
      {
        get: (_target, method) => {
          if (typeof method !== "string") return undefined;
          return (...args: unknown[]) => {
            call.chain.push({ method, args });
            return chain;
          };
        },
      },
    );
    return chain;
  };

  const collection = (database: string | undefined, name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method) => (typeof method === "string" ? (...args: unknown[]) => record({ database, collection: name, method, args, chain: [] }) : undefined),
      },
    );

  const database = (name: string | undefined): object =>
    new Proxy(
      {},
      {
        get: (_target, property) => {
          if (typeof property !== "string") return undefined;
          if (property === "getCollection") return (collectionName: unknown) => collection(name, requireName(collectionName, "getCollection"));
          if (property === "getSiblingDB") return (databaseName: unknown) => database(requireName(databaseName, "getSiblingDB"));
          if (DATABASE_METHODS.has(property)) return (...args: unknown[]) => record({ database: name, method: property, args, chain: [] });
          return collection(name, property);
        },
      },
    );

  const scope: Record<string, unknown> = {
    db: database(undefined),
    print: () => undefined,
    printjson: () => undefined,
    ObjectId: (hex?: unknown) => new MongoShellLiteral(`ObjectId(${JSON.stringify(hex === undefined ? newObjectIdHex() : requireObjectIdHex(hex))})`),
    ISODate: (value?: unknown) => new MongoShellLiteral(`ISODate(${JSON.stringify(isoDate(value === undefined ? new Date() : new Date(value as string)))})`),
    NumberInt: (value: unknown) => new MongoShellLiteral(`NumberInt(${JSON.stringify(String(value))})`),
    NumberLong: (value: unknown) => new MongoShellLiteral(`NumberLong(${JSON.stringify(String(value))})`),
    NumberDecimal: (value: unknown) => new MongoShellLiteral(`NumberDecimal(${JSON.stringify(String(value))})`),
    UUID: (value?: unknown) => new MongoShellLiteral(`UUID(${JSON.stringify(value === undefined ? crypto.randomUUID() : String(value))})`),
  };

  try {
    new Function(...Object.keys(scope), `"use strict";\n${script}`)(...Object.values(scope));
    if (calls.length === 0) return { ok: false, error: "The script made no database calls." };
    return { ok: true, commands: calls.map(formatRecordedCall) };
  } catch (error) {
    return { ok: false, error: `Script error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function requireName(value: unknown, method: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${method}() requires a name string.`);
  return value;
}

function requireObjectIdHex(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{24}$/.test(value)) throw new Error("ObjectId() requires a 24-character hex string.");
  return value;
}

let objectIdCounter = Math.floor(Math.random() * 0xffffff);

/** A real ObjectId, so a value stored in a variable stays the same across the calls that use it. */
function newObjectIdHex(): string {
  const bytes = new Uint8Array(12);
  const seconds = Math.floor(Date.now() / 1000);
  bytes[0] = seconds >>> 24;
  bytes[1] = (seconds >>> 16) & 0xff;
  bytes[2] = (seconds >>> 8) & 0xff;
  bytes[3] = seconds & 0xff;
  crypto.getRandomValues(bytes.subarray(4, 9));
  objectIdCounter = (objectIdCounter + 1) % 0x1000000;
  bytes[9] = objectIdCounter >>> 16;
  bytes[10] = (objectIdCounter >>> 8) & 0xff;
  bytes[11] = objectIdCounter & 0xff;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isoDate(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date.");
  return date.toISOString();
}

function formatRecordedCall(call: RecordedCall): string {
  let text = "db";
  if (call.database !== undefined) text += `.getSiblingDB(${JSON.stringify(call.database)})`;
  if (call.collection !== undefined) text += `.getCollection(${JSON.stringify(call.collection)})`;
  text += `.${call.method}(${formatArguments(call.args)})`;
  for (const link of call.chain) text += `.${link.method}(${formatArguments(link.args)})`;
  return text;
}

function formatArguments(args: unknown[]): string {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end -= 1;
  return args
    .slice(0, end)
    .map((arg) => formatValue(arg))
    .join(", ");
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof MongoShellLiteral) return value.text;
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return String(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error(`${value} cannot be stored in MongoDB from a script.`);
      return String(value);
    case "bigint":
      return `NumberLong(${JSON.stringify(value.toString())})`;
    case "function":
      throw new Error(`${MONGO_SCRIPT_RESULTS_UNAVAILABLE}, so callbacks such as forEach() or map() on a cursor are not supported.`);
  }
  if (value instanceof Date) return `ISODate(${JSON.stringify(isoDate(value))})`;
  if (value instanceof RegExp) return `/${value.source}/${value.flags}`;
  if (Array.isArray(value)) return `[${value.map((item) => formatValue(item)).join(", ")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}: ${formatValue(item)}`).join(", ")}}`;
  }
  throw new Error(`${Object.prototype.toString.call(value)} values cannot be sent to MongoDB from a script.`);
}
