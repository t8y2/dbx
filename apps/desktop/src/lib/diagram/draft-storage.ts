import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import type { ColumnInfo } from "@/types/database";
import type { DiagramPosition, DiagramTable } from "./erDiagram";
import { isLiveTable, needsDiagramSync } from "./erDiagram";
import type { DiagramLayer } from "@/types/diagram";
import { diagramIdentityKey } from "./diagramMetadataLoader";

export interface LiveTablePatch {
  tableName: string;
  schema?: string;
  pendingColumns: ColumnInfo[];
  droppedColumnNames?: string[];
  pendingDrop?: boolean;
}

function storageKey(kind: "draft-tables" | "layers" | "positions" | "live-patches", connectionId: string, database: string, schema: string): string {
  return ["dbx", "diagram", kind, "v1", connectionId, database, schema].join(":");
}

function isValidColumn(value: unknown): value is ColumnInfo {
  if (!value || typeof value !== "object") return false;
  const col = value as Partial<ColumnInfo>;
  return typeof col.name === "string" && typeof col.data_type === "string" && typeof col.is_nullable === "boolean";
}

function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function sanitizePositions(raw: unknown): Record<string, DiagramPosition> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, DiagramPosition> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!name || typeof value !== "object" || value == null || Array.isArray(value)) continue;
    const x = (value as { x?: unknown }).x;
    const y = (value as { y?: unknown }).y;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    out[name] = { x, y };
  }
  return out;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function loadDraftTables(connectionId: string, database: string, schema: string): DiagramTable[] {
  if (!connectionId || !database) return [];
  const key = storageKey("draft-tables", connectionId, database, schema);
  const list = parseJson<DiagramTable[]>(safeLocalStorageGet(key), []);
  return list
    .filter((t) => t && typeof t.name === "string" && Array.isArray(t.columns))
    .map((t) => ({
      ...t,
      foreignKeys: t.foreignKeys || [],
      origin: "draft" as const,
      syncStatus: t.syncStatus === "error" ? "error" : "pending",
    }));
}

export function saveDraftTables(tables: DiagramTable[], connectionId: string, database: string, schema: string): void {
  if (!connectionId || !database) return;
  const key = storageKey("draft-tables", connectionId, database, schema);
  const drafts = tables.filter((t) => (t.origin ?? "live") === "draft");
  safeLocalStorageSet(key, JSON.stringify(drafts));
}

export function loadPersistedLayers(connectionId: string, database: string, schema: string): DiagramLayer[] {
  if (!connectionId || !database) return [];
  const key = storageKey("layers", connectionId, database, schema);
  return parseJson<DiagramLayer[]>(safeLocalStorageGet(key), []);
}

export function savePersistedLayers(layers: DiagramLayer[], connectionId: string, database: string, schema: string): void {
  if (!connectionId || !database) return;
  const key = storageKey("layers", connectionId, database, schema);
  safeLocalStorageSet(key, JSON.stringify(layers));
}

export function loadPersistedPositions(connectionId: string, database: string, schema: string): Record<string, DiagramPosition> {
  if (!connectionId || !database) return {};
  const key = storageKey("positions", connectionId, database, schema);
  return sanitizePositions(parseJson<unknown>(safeLocalStorageGet(key), {}));
}

export function savePersistedPositions(positions: Record<string, DiagramPosition>, connectionId: string, database: string, schema: string): void {
  if (!connectionId || !database) return;
  const key = storageKey("positions", connectionId, database, schema);
  safeLocalStorageSet(key, JSON.stringify(sanitizePositions(positions)));
}

/** True when at least one known table name has a finite saved position. */
export function hasUsablePersistedPositions(saved: Record<string, DiagramPosition>, tableNames: string[]): boolean {
  for (const name of tableNames) {
    const pos = saved[name];
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) return true;
  }
  return false;
}

export function loadLiveTablePatches(connectionId: string, database: string, schema: string): LiveTablePatch[] {
  if (!connectionId || !database) return [];
  const key = storageKey("live-patches", connectionId, database, schema);
  const list = parseJson<unknown[]>(safeLocalStorageGet(key), []);
  if (!Array.isArray(list)) return [];
  return list
    .filter((item): item is LiveTablePatch => {
      if (!item || typeof item !== "object") return false;
      const patch = item as Partial<LiveTablePatch>;
      if (typeof patch.tableName !== "string") return false;
      const pendingColumns = Array.isArray(patch.pendingColumns) ? patch.pendingColumns : [];
      if (!pendingColumns.every(isValidColumn)) return false;
      const droppedColumnNames = sanitizeStringList(patch.droppedColumnNames);
      const pendingDrop = patch.pendingDrop === true;
      return pendingColumns.length > 0 || droppedColumnNames.length > 0 || pendingDrop;
    })
    .map((patch) => {
      const pendingColumns = Array.isArray(patch.pendingColumns) ? patch.pendingColumns.filter(isValidColumn) : [];
      const droppedColumnNames = sanitizeStringList(patch.droppedColumnNames);
      const next: LiveTablePatch = {
        tableName: patch.tableName,
        schema: patch.schema,
        pendingColumns: pendingColumns.map((col) => ({ ...col })),
      };
      if (droppedColumnNames.length) next.droppedColumnNames = droppedColumnNames;
      if (patch.pendingDrop === true) next.pendingDrop = true;
      return next;
    });
}

export function saveLiveTablePatches(tables: DiagramTable[], connectionId: string, database: string, schema: string): void {
  if (!connectionId || !database) return;
  const key = storageKey("live-patches", connectionId, database, schema);
  safeLocalStorageSet(key, JSON.stringify(liveTablePatches(tables)));
}

function liveTablePatches(tables: DiagramTable[]): LiveTablePatch[] {
  const patches: LiveTablePatch[] = [];
  for (const table of tables) {
    if (!isLiveTable(table) || !needsDiagramSync(table)) continue;
    const pendingNames = new Set(table.pendingColumnNames ?? []);
    const pendingColumns = table.columns.filter((col) => pendingNames.has(col.name));
    const droppedColumnNames = [...(table.droppedColumnNames ?? [])];
    if (pendingColumns.length === 0 && droppedColumnNames.length === 0 && !table.pendingDrop) continue;
    const patch: LiveTablePatch = {
      tableName: table.name,
      schema: table.schema,
      pendingColumns: pendingColumns.map((col) => ({ ...col })),
    };
    if (droppedColumnNames.length) patch.droppedColumnNames = droppedColumnNames;
    if (table.pendingDrop) patch.pendingDrop = true;
    patches.push(patch);
  }
  return patches;
}

/** Persist only edits since the last applied snapshot, never the absent part of a focused schema. */
export function saveFocusedDiagramState(tables: DiagramTable[], previousTables: DiagramTable[], positions: Record<string, DiagramPosition>, layers: DiagramLayer[], connectionId: string, database: string, schema: string, legacySchema = schema): void {
  if (!connectionId || !database) return;
  const previous = new Map(previousTables.map((table) => [diagramIdentityKey(table), table]));
  const current = new Map(tables.map((table) => [diagramIdentityKey(table), table]));
  const changed = new Set([...previous.keys(), ...current.keys()].filter((key) => JSON.stringify(previous.get(key)) !== JSON.stringify(current.get(key))));
  if (changed.size) {
    const drafts = loadDraftTables(connectionId, database, schema).filter((table) => !changed.has(diagramIdentityKey(table)));
    saveDraftTables([...drafts, ...tables.filter((table) => changed.has(diagramIdentityKey(table)))], connectionId, database, schema);
    const oldPatches = loadLiveTablePatches(connectionId, database, schema).filter(
      (patch) =>
        ![...changed].some((key) => {
          const table = current.get(key) ?? previous.get(key)!;
          return patch.tableName === table.name && (patch.schema === table.schema || (patch.schema === undefined && (!table.schema || table.schema === legacySchema)));
        }),
    );
    const newPatches = liveTablePatches(tables.filter((table) => changed.has(diagramIdentityKey(table))));
    safeLocalStorageSet(storageKey("live-patches", connectionId, database, schema), JSON.stringify([...oldPatches, ...newPatches]));
  }
  const loadedNames = new Set([...previousTables, ...tables].flatMap((table) => (!table.schema || table.schema === legacySchema ? [table.name, table.schema ? `${table.schema}.${table.name}` : table.name] : [`${table.schema}.${table.name}`])));
  const scopedPositions = Object.fromEntries(Object.entries(positions).filter(([name]) => loadedNames.has(name)));
  savePersistedPositions({ ...loadPersistedPositions(connectionId, database, schema), ...scopedPositions }, connectionId, database, schema);
  const mergedLayers = layers.map((layer) => ({ ...layer, tableNames: [...layer.tableNames] }));
  for (const stored of loadPersistedLayers(connectionId, database, schema)) {
    const unloadedMembers = stored.tableNames.filter((name) => !loadedNames.has(name));
    const next = mergedLayers.find((layer) => layer.id === stored.id);
    if (next) next.tableNames = [...new Set([...next.tableNames, ...unloadedMembers])];
    else if (unloadedMembers.length || stored.tableNames.length === 0) mergedLayers.push({ ...stored, tableNames: unloadedMembers });
  }
  savePersistedLayers(mergedLayers, connectionId, database, schema);
}

/** Merge saved pending adds/drops onto live tables loaded from DB metadata. */
export function applyLiveTablePatches(tables: DiagramTable[], patches: LiveTablePatch[], legacySchema?: string): DiagramTable[] {
  if (patches.length === 0) return tables;
  const byName = new Map(patches.map((p) => [diagramIdentityKey({ name: p.tableName, schema: p.schema ?? legacySchema }), p]));
  const nameCounts = new Map<string, number>();
  for (const table of tables) nameCounts.set(table.name, (nameCounts.get(table.name) ?? 0) + 1);
  return tables.map((table) => {
    if (!isLiveTable(table)) return table;
    const unambiguous = nameCounts.get(table.name) === 1;
    const patch = byName.get(diagramIdentityKey(table)) ?? (unambiguous ? byName.get(diagramIdentityKey({ name: table.name })) : undefined);
    if (!patch) return table;

    const existing = new Set(table.columns.map((c) => c.name.toLowerCase()));
    const pendingColumns = patch.pendingColumns.filter((col) => !existing.has(col.name.toLowerCase()));
    const columnNames = new Set([...existing, ...pendingColumns.map((col) => col.name.toLowerCase())]);
    const droppedColumnNames = (patch.droppedColumnNames ?? []).filter((name) => columnNames.has(name.toLowerCase()));

    let next: DiagramTable = table;
    if (pendingColumns.length > 0) {
      next = {
        ...next,
        columns: [...next.columns, ...pendingColumns.map((col) => ({ ...col }))],
        pendingColumnNames: pendingColumns.map((col) => col.name),
      };
    }
    if (droppedColumnNames.length > 0) {
      next = { ...next, droppedColumnNames };
    }
    if (patch.pendingDrop) {
      next = { ...next, pendingDrop: true };
    }
    return next;
  });
}
