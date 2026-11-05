import type { DiagramTable } from "./erDiagram";
import { diagramIdentityKey, normalizedDiagramRoots, type FocusedDiagramLoadRequest } from "./diagramMetadataLoader";

export const DIAGRAM_METADATA_CACHE_TTL_MS = 5 * 60 * 1000;
interface CacheEntry {
  cachedAt: number;
  expiresAt: number;
  tables: DiagramTable[];
}
interface PendingLoad {
  force: boolean;
  promise: Promise<DiagramTable[]>;
}
const entries = new Map<string, CacheEntry>();
const inFlight = new Map<string, PendingLoad>();
// Metadata is JSON data; this also accepts Vue reactive snapshots without proxy cloning errors.
const clone = (tables: DiagramTable[]): DiagramTable[] => JSON.parse(JSON.stringify(tables));

export function focusedDiagramCacheKey(request: FocusedDiagramLoadRequest): string {
  return JSON.stringify({ version: 1, connectionId: request.connectionId, database: request.database, catalog: request.catalog ?? "", roots: normalizedDiagramRoots(request.roots).map(diagramIdentityKey), traversal: "outbound-fk" });
}

export function getFocusedDiagramCache(key: string, now = Date.now()): DiagramTable[] | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (now >= entry.expiresAt) {
    entries.delete(key);
    return undefined;
  }
  return clone(entry.tables);
}

export function setFocusedDiagramCache(key: string, tables: DiagramTable[], now = Date.now()): void {
  entries.set(key, { cachedAt: now, expiresAt: now + DIAGRAM_METADATA_CACHE_TTL_MS, tables: clone(tables) });
}

export async function loadFocusedDiagramCached(key: string, loader: () => Promise<DiagramTable[]>, options: { force?: boolean } = {}): Promise<DiagramTable[]> {
  if (!options.force) {
    const cached = getFocusedDiagramCache(key);
    if (cached) return cached;
  }
  const existing = inFlight.get(key);
  if (existing && (!options.force || existing.force)) return clone(await existing.promise);
  const pending: PendingLoad = { force: !!options.force, promise: Promise.resolve([]) };
  pending.promise = Promise.resolve()
    .then(loader)
    .then((tables) => {
      // A forced request can supersede an older ordinary request without deleting its valid snapshot.
      if (inFlight.get(key) === pending) setFocusedDiagramCache(key, tables);
      return tables;
    })
    .finally(() => {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    });
  inFlight.set(key, pending);
  return clone(await pending.promise);
}

export function invalidateFocusedDiagramCache(match: (key: string) => boolean = () => true): void {
  for (const key of entries.keys()) if (match(key)) entries.delete(key);
  for (const key of inFlight.keys()) if (match(key)) inFlight.delete(key);
}

export function clearFocusedDiagramCacheForTests(): void {
  invalidateFocusedDiagramCache();
}
