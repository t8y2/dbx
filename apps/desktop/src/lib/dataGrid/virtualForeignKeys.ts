import type { ForeignKeyInfo } from "@/types/database";

export const VIRTUAL_FOREIGN_KEY_BUNDLE_VERSION = 1 as const;
export const VIRTUAL_FOREIGN_KEY_NAME_PREFIX = "dbx_vfk:";
export const VIRTUAL_FOREIGN_KEY_MAX_NOTE_LENGTH = 200;

export interface VirtualForeignKeyEndpoint {
  database?: string;
  schema?: string;
  table: string;
  column: string;
}

export interface VirtualForeignKeyRule {
  id: string;
  connectionId: string;
  source: VirtualForeignKeyEndpoint;
  target: VirtualForeignKeyEndpoint;
  bidirectional: boolean;
  note?: string;
}

export interface PortableVirtualForeignKeyRule {
  source: VirtualForeignKeyEndpoint;
  target: VirtualForeignKeyEndpoint;
  bidirectional?: boolean;
  note?: string;
}

export interface PortableVirtualForeignKeyBundle {
  version: typeof VIRTUAL_FOREIGN_KEY_BUNDLE_VERSION;
  rules: PortableVirtualForeignKeyRule[];
}

export interface VirtualForeignKeyTableContext {
  connectionId: string;
  database?: string;
  schema?: string;
  tableName: string;
  databaseTreeHierarchy: boolean;
}

export interface MergeVirtualForeignKeyResult {
  rules: VirtualForeignKeyRule[];
  added: number;
  upgraded: number;
}

export interface ParsePortableVirtualForeignKeyBundleResult {
  rules: PortableVirtualForeignKeyRule[];
  error?: string;
}

const ALLOWED_ENDPOINT_KEYS = new Set(["database", "schema", "table", "column"]);
const ALLOWED_PORTABLE_RULE_KEYS = new Set(["source", "target", "bidirectional", "note"]);

function trimOptional(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeVirtualForeignKeyEndpoint(value: unknown): VirtualForeignKeyEndpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const table = trimOptional(record.table);
  const column = trimOptional(record.column);
  if (!table || !column) return null;
  const database = trimOptional(record.database);
  const schema = trimOptional(record.schema);
  return {
    ...(database ? { database } : {}),
    ...(schema ? { schema } : {}),
    table,
    column,
  };
}

export function virtualForeignKeyEndpointKey(endpoint: VirtualForeignKeyEndpoint): string {
  return [(endpoint.database ?? "").trim().toLowerCase(), (endpoint.schema ?? "").trim().toLowerCase(), endpoint.table.trim().toLowerCase(), endpoint.column.trim().toLowerCase()].join("\u0000");
}

export function virtualForeignKeyEndpointsEqual(left: VirtualForeignKeyEndpoint, right: VirtualForeignKeyEndpoint): boolean {
  return virtualForeignKeyEndpointKey(left) === virtualForeignKeyEndpointKey(right);
}

export function formatVirtualForeignKeyEndpoint(endpoint: VirtualForeignKeyEndpoint): string {
  const scope = [endpoint.database, endpoint.schema].filter((part): part is string => !!part?.trim()).join(".");
  const base = `${endpoint.table}.${endpoint.column}`;
  return scope ? `${scope}.${base}` : base;
}

export function createVirtualForeignKeyRuleId(connectionId: string, source: VirtualForeignKeyEndpoint, target: VirtualForeignKeyEndpoint): string {
  const raw = `${connectionId.trim()}::${virtualForeignKeyEndpointKey(source)}=>${virtualForeignKeyEndpointKey(target)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `vfk_${hex}_${source.table.toLowerCase()}_${source.column.toLowerCase()}_${target.table.toLowerCase()}_${target.column.toLowerCase()}`.slice(0, 96);
}

export function normalizeVirtualForeignKeyRule(value: unknown): VirtualForeignKeyRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const connectionId = trimOptional(record.connectionId);
  if (!connectionId) return null;
  const source = normalizeVirtualForeignKeyEndpoint(record.source);
  const target = normalizeVirtualForeignKeyEndpoint(record.target);
  if (!source || !target || virtualForeignKeyEndpointsEqual(source, target)) return null;
  const id = trimOptional(record.id) ?? createVirtualForeignKeyRuleId(connectionId, source, target);
  const bidirectional = record.bidirectional === true;
  const noteRaw = trimOptional(record.note);
  const note = noteRaw ? noteRaw.slice(0, VIRTUAL_FOREIGN_KEY_MAX_NOTE_LENGTH) : undefined;
  return {
    id,
    connectionId,
    source,
    target,
    bidirectional,
    ...(note ? { note } : {}),
  };
}

export function normalizeVirtualForeignKeyRules(value: unknown): VirtualForeignKeyRule[] {
  if (!Array.isArray(value)) return [];
  const result: VirtualForeignKeyRule[] = [];
  for (const item of value) {
    const normalized = normalizeVirtualForeignKeyRule(item);
    if (!normalized) continue;
    const matchIndex = result.findIndex(
      (existing) =>
        existing.connectionId === normalized.connectionId &&
        ((virtualForeignKeyEndpointsEqual(existing.source, normalized.source) && virtualForeignKeyEndpointsEqual(existing.target, normalized.target)) || (virtualForeignKeyEndpointsEqual(existing.source, normalized.target) && virtualForeignKeyEndpointsEqual(existing.target, normalized.source))),
    );
    if (matchIndex < 0) {
      result.push(normalized);
      continue;
    }
    const existing = result[matchIndex]!;
    const reversed = virtualForeignKeyEndpointsEqual(existing.source, normalized.target) && virtualForeignKeyEndpointsEqual(existing.target, normalized.source);
    result[matchIndex] = {
      ...existing,
      bidirectional: existing.bidirectional || normalized.bidirectional || reversed,
      note: existing.note || normalized.note,
    };
  }
  return result;
}

export function upsertVirtualForeignKeyRule(existing: readonly VirtualForeignKeyRule[], candidate: Omit<VirtualForeignKeyRule, "id"> & { id?: string }): VirtualForeignKeyRule[] {
  const normalized = normalizeVirtualForeignKeyRule({
    ...candidate,
    id: candidate.id || createVirtualForeignKeyRuleId(candidate.connectionId, candidate.source, candidate.target),
  });
  if (!normalized) return [...existing];
  const next = [...existing];
  const index = next.findIndex(
    (item) =>
      item.id === normalized.id ||
      (item.connectionId === normalized.connectionId &&
        ((virtualForeignKeyEndpointsEqual(item.source, normalized.source) && virtualForeignKeyEndpointsEqual(item.target, normalized.target)) || (virtualForeignKeyEndpointsEqual(item.source, normalized.target) && virtualForeignKeyEndpointsEqual(item.target, normalized.source)))),
  );
  if (index < 0) {
    next.push(normalized);
    return next;
  }
  const previous = next[index]!;
  const reversed = virtualForeignKeyEndpointsEqual(previous.source, normalized.target) && virtualForeignKeyEndpointsEqual(previous.target, normalized.source);
  next[index] = {
    ...previous,
    bidirectional: reversed ? true : normalized.bidirectional,
    note: normalized.note ?? previous.note,
  };
  return next;
}

export function mergeVirtualForeignKeyRules(existing: readonly VirtualForeignKeyRule[], connectionId: string, incoming: readonly PortableVirtualForeignKeyRule[]): MergeVirtualForeignKeyResult {
  const trimmedConnectionId = connectionId.trim();
  if (!trimmedConnectionId) return { rules: [...existing], added: 0, upgraded: 0 };

  const next = [...existing];
  let added = 0;
  let upgraded = 0;

  for (const item of incoming) {
    const source = normalizeVirtualForeignKeyEndpoint(item.source);
    const target = normalizeVirtualForeignKeyEndpoint(item.target);
    if (!source || !target || virtualForeignKeyEndpointsEqual(source, target)) continue;
    const bidirectional = item.bidirectional === true;
    const note = trimOptional(item.note)?.slice(0, VIRTUAL_FOREIGN_KEY_MAX_NOTE_LENGTH);

    const matchIndex = next.findIndex(
      (rule) => rule.connectionId === trimmedConnectionId && ((virtualForeignKeyEndpointsEqual(rule.source, source) && virtualForeignKeyEndpointsEqual(rule.target, target)) || (virtualForeignKeyEndpointsEqual(rule.source, target) && virtualForeignKeyEndpointsEqual(rule.target, source))),
    );

    if (matchIndex < 0) {
      next.push({
        id: createVirtualForeignKeyRuleId(trimmedConnectionId, source, target),
        connectionId: trimmedConnectionId,
        source,
        target,
        bidirectional,
        ...(note ? { note } : {}),
      });
      added += 1;
      continue;
    }

    const current = next[matchIndex]!;
    const reversed = virtualForeignKeyEndpointsEqual(current.source, target) && virtualForeignKeyEndpointsEqual(current.target, source);
    const nextBidirectional = current.bidirectional || bidirectional || reversed;
    const nextNote = current.note || note;
    if (nextBidirectional !== current.bidirectional || nextNote !== current.note) {
      if (nextBidirectional && !current.bidirectional) upgraded += 1;
      next[matchIndex] = {
        ...current,
        bidirectional: nextBidirectional,
        ...(nextNote ? { note: nextNote } : {}),
      };
    }
  }

  return { rules: next, added, upgraded };
}

function parsePortableEndpointStrict(raw: unknown, label: string): { endpoint?: VirtualForeignKeyEndpoint; error?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `${label} must be an object` };
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_ENDPOINT_KEYS.has(key)) return { error: `${label} has unsupported field "${key}"` };
    if (record[key] !== undefined && record[key] !== null && typeof record[key] !== "string") {
      return { error: `${label}.${key} must be a string` };
    }
  }
  const endpoint = normalizeVirtualForeignKeyEndpoint(record);
  if (!endpoint) return { error: `${label} requires non-empty table and column` };
  return { endpoint };
}

export function parsePortableVirtualForeignKeyBundle(rawText: string): ParsePortableVirtualForeignKeyBundleResult {
  const trimmed = rawText.trim();
  if (!trimmed) return { rules: [], error: "JSON input is empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { rules: [], error: error instanceof Error ? error.message : String(error) };
  }

  let rawRules: unknown;
  if (Array.isArray(parsed)) {
    rawRules = parsed;
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (obj.version !== undefined && obj.version !== VIRTUAL_FOREIGN_KEY_BUNDLE_VERSION) {
      return { rules: [], error: `Unsupported version: ${String(obj.version)}` };
    }
    rawRules = obj.rules;
  }
  if (!Array.isArray(rawRules)) {
    return { rules: [], error: 'Expected a JSON array or an object with a "rules" array' };
  }

  const rules: PortableVirtualForeignKeyRule[] = [];
  for (let index = 0; index < rawRules.length; index += 1) {
    const entry = rawRules[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { rules: [], error: `Rule #${index + 1} must be an object` };
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!ALLOWED_PORTABLE_RULE_KEYS.has(key)) {
        return { rules: [], error: `Rule #${index + 1} has unsupported field "${key}"` };
      }
    }
    const sourceResult = parsePortableEndpointStrict(record.source, `Rule #${index + 1}.source`);
    if (sourceResult.error || !sourceResult.endpoint) return { rules: [], error: sourceResult.error };
    const targetResult = parsePortableEndpointStrict(record.target, `Rule #${index + 1}.target`);
    if (targetResult.error || !targetResult.endpoint) return { rules: [], error: targetResult.error };
    if (virtualForeignKeyEndpointsEqual(sourceResult.endpoint, targetResult.endpoint)) {
      return { rules: [], error: `Rule #${index + 1} references the same column on both ends` };
    }
    if (record.bidirectional !== undefined && typeof record.bidirectional !== "boolean") {
      return { rules: [], error: `Rule #${index + 1}.bidirectional must be a boolean` };
    }
    if (record.note !== undefined && record.note !== null && typeof record.note !== "string") {
      return { rules: [], error: `Rule #${index + 1}.note must be a string` };
    }
    const note = trimOptional(record.note)?.slice(0, VIRTUAL_FOREIGN_KEY_MAX_NOTE_LENGTH);
    rules.push({
      source: sourceResult.endpoint,
      target: targetResult.endpoint,
      bidirectional: record.bidirectional === true,
      ...(note ? { note } : {}),
    });
  }

  return { rules };
}

export function exportPortableVirtualForeignKeyBundle(rules: readonly VirtualForeignKeyRule[]): string {
  const bundle: PortableVirtualForeignKeyBundle = {
    version: VIRTUAL_FOREIGN_KEY_BUNDLE_VERSION,
    rules: rules.map((rule) => ({
      source: { ...rule.source },
      target: { ...rule.target },
      bidirectional: rule.bidirectional,
      ...(rule.note ? { note: rule.note } : {}),
    })),
  };
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export function isVirtualForeignKeyName(name: string | undefined | null): boolean {
  return typeof name === "string" && name.startsWith(VIRTUAL_FOREIGN_KEY_NAME_PREFIX);
}

export function virtualForeignKeyRuleIdFromName(name: string | undefined | null): string | null {
  if (!isVirtualForeignKeyName(name)) return null;
  const body = name!.slice(VIRTUAL_FOREIGN_KEY_NAME_PREFIX.length);
  const sep = body.lastIndexOf(":");
  return sep > 0 ? body.slice(0, sep) : body;
}

function endpointMatchesTable(endpoint: VirtualForeignKeyEndpoint, context: VirtualForeignKeyTableContext): boolean {
  if (endpoint.table.trim().toLowerCase() !== context.tableName.trim().toLowerCase()) return false;
  if (context.databaseTreeHierarchy) {
    const endpointScope = (endpoint.database || endpoint.schema || "").trim().toLowerCase();
    const currentScope = (context.database || context.schema || "").trim().toLowerCase();
    if (endpointScope && currentScope && endpointScope !== currentScope) return false;
    return true;
  }
  const endpointDatabase = (endpoint.database || "").trim().toLowerCase();
  const currentDatabase = (context.database || "").trim().toLowerCase();
  if (endpointDatabase && currentDatabase && endpointDatabase !== currentDatabase) return false;

  const endpointSchema = (endpoint.schema || "").trim().toLowerCase();
  const currentSchema = (context.schema || "").trim().toLowerCase();
  if (endpointSchema && currentSchema && endpointSchema !== currentSchema) return false;
  return true;
}

function targetRefSchema(endpoint: VirtualForeignKeyEndpoint, context: VirtualForeignKeyTableContext): string | null {
  if (context.databaseTreeHierarchy) {
    return endpoint.database || endpoint.schema || null;
  }
  return endpoint.schema || null;
}

export function virtualForeignKeysForTable(rules: readonly VirtualForeignKeyRule[], context: VirtualForeignKeyTableContext): ForeignKeyInfo[] {
  if (!context.connectionId || !context.tableName) return [];
  const projected: ForeignKeyInfo[] = [];
  const seen = new Set<string>();

  const pushEdge = (rule: VirtualForeignKeyRule, direction: "fwd" | "rev", from: VirtualForeignKeyEndpoint, to: VirtualForeignKeyEndpoint) => {
    if (!endpointMatchesTable(from, context)) return;
    const refSchema = targetRefSchema(to, context);
    const dedupeKey = [from.column.toLowerCase(), (refSchema ?? "").toLowerCase(), to.table.toLowerCase(), to.column.toLowerCase()].join("\u0000");
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    projected.push({
      name: `${VIRTUAL_FOREIGN_KEY_NAME_PREFIX}${rule.id}:${direction}`,
      column: from.column,
      ref_schema: refSchema,
      ref_table: to.table,
      ref_column: to.column,
    });
  };

  for (const rule of rules) {
    if (rule.connectionId !== context.connectionId) continue;
    pushEdge(rule, "fwd", rule.source, rule.target);
    if (rule.bidirectional) {
      pushEdge(rule, "rev", rule.target, rule.source);
    }
  }

  return projected;
}

export function virtualForeignKeysForConnection(rules: readonly VirtualForeignKeyRule[], connectionId: string): VirtualForeignKeyRule[] {
  if (!connectionId) return [];
  return rules.filter((rule) => rule.connectionId === connectionId);
}

export function virtualForeignKeysTouchingTable(rules: readonly VirtualForeignKeyRule[], context: VirtualForeignKeyTableContext): VirtualForeignKeyRule[] {
  if (!context.connectionId || !context.tableName) return [];
  return rules.filter((rule) => rule.connectionId === context.connectionId && (endpointMatchesTable(rule.source, context) || endpointMatchesTable(rule.target, context)));
}
