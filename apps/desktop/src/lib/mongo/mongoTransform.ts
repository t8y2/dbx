import { mongoCompareFingerprint, type MongoCompareDocument } from "./mongoCompare";
import { mongoExtendedJsonValueType } from "./mongoDocumentValues";

export type MongoTransformAction = "remove" | "replace" | "redact" | "hash" | "copy" | "rename";
export interface MongoTransformRule {
  path: string;
  action: MongoTransformAction;
  value?: unknown;
  destination?: string;
}
const actions = new Set(["remove", "replace", "redact", "hash", "copy", "rename"]);
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function pathParts(path: string, wildcard: boolean): string[] {
  const parts = path.split(".");
  if (!path || parts.length > 32 || parts.some((part) => !part || forbidden.has(part) || part.startsWith("$") || part.includes("\0") || (!wildcard && part === "*"))) throw new Error("Invalid field path: " + path);
  if (parts[0] === "_id" || parts[0] === "*") throw new Error("_id cannot be transformed; choose an explicit root field");
  return parts;
}
export function validateMongoTransformRules(value: unknown): MongoTransformRule[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error("Enter between 1 and 100 transformation rules");
  for (const rule of value) {
    if (!rule || typeof rule !== "object" || typeof rule.path !== "string" || !actions.has(rule.action)) throw new Error("Invalid transformation rule");
    pathParts(rule.path, true);
    if (rule.action === "replace" && !Object.prototype.hasOwnProperty.call(rule, "value")) throw new Error("Replacement value is required");
    if (rule.action === "copy" || rule.action === "rename") {
      if (typeof rule.destination !== "string" || rule.path.includes("*")) throw new Error("Copy/rename requires a destination and a source without wildcards");
      pathParts(rule.destination, false);
      if (rule.destination === rule.path || rule.destination.startsWith(rule.path + ".") || rule.path.startsWith(rule.destination + ".")) throw new Error("Source and destination paths must not overlap");
    }
  }
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && !mongoExtendedJsonValueType(value);
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
function locations(root: MongoCompareDocument, parts: string[]): { parent: Record<string, unknown> | unknown[]; key: string }[] {
  const found: { parent: Record<string, unknown> | unknown[]; key: string }[] = [];
  function visit(value: unknown, index: number) {
    if (!record(value) && !Array.isArray(value)) return;
    const part = parts[index];
    const keys = part === "*" ? Object.keys(value) : [part];
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (index === parts.length - 1) found.push({ parent: value, key });
      else visit((value as Record<string, unknown>)[key], index + 1);
    }
  }
  visit(root, 0);
  return found;
}
function setPath(root: MongoCompareDocument, path: string, value: unknown) {
  const parts = pathParts(path, false);
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    if (!Object.prototype.hasOwnProperty.call(parent, part)) parent[part] = {};
    if (!record(parent[part])) throw new Error("Destination parent is not a document: " + path);
    parent = parent[part] as MongoCompareDocument;
  }
  if (Object.prototype.hasOwnProperty.call(parent, parts[parts.length - 1]!)) throw new Error("Destination already exists: " + path);
  parent[parts[parts.length - 1]!] = clone(value);
}
/** Rules are applied in order to a copy. BSON scalar wrappers remain atomic. */
export async function transformMongoDocuments(documents: MongoCompareDocument[], input: MongoTransformRule[], options: { secret?: string; signal?: AbortSignal } = {}): Promise<MongoCompareDocument[]> {
  const rules = validateMongoTransformRules(input);
  if (rules.some((rule) => rule.action === "hash") && (!options.secret || options.secret.length < 16)) throw new Error("Hash masking requires a secret of at least 16 characters");
  const key = rules.some((rule) => rule.action === "hash") ? await crypto.subtle.importKey("raw", new TextEncoder().encode(options.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]) : null;
  const result: MongoCompareDocument[] = [];
  let bytes = 0;
  for (const document of documents) {
    options.signal?.throwIfAborted();
    const output = clone(document);
    for (const rule of rules) {
      for (const location of locations(output, pathParts(rule.path, true))) {
        options.signal?.throwIfAborted();
        const parent = location.parent as Record<string, unknown>;
        const value = parent[location.key];
        if (rule.action === "copy" || rule.action === "rename") setPath(output, rule.destination!, value);
        if (rule.action === "remove" || rule.action === "rename") {
          // Removing an array slot must not create sparse arrays or silently shift indices.
          if (Array.isArray(location.parent)) location.parent[Number(location.key)] = null;
          else delete parent[location.key];
        } else if (rule.action === "replace") parent[location.key] = clone(rule.value);
        else if (rule.action === "redact") parent[location.key] = "[REDACTED]";
        else if (rule.action === "hash") {
          const digest = await crypto.subtle.sign("HMAC", key!, new TextEncoder().encode(mongoCompareFingerprint(value)));
          parent[location.key] = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        }
      }
    }
    bytes += new TextEncoder().encode(JSON.stringify(output)).byteLength;
    if (bytes > 64 * 1024 * 1024) throw new Error("Transformed documents exceed the 64 MiB limit");
    result.push(output);
  }
  return result;
}
