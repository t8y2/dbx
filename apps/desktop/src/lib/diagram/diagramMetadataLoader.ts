import type { ColumnInfo, ForeignKeyInfo, IndexInfo } from "@/types/database";
import type { DiagramTable } from "./erDiagram";

export interface DiagramTableIdentity {
  schema: string;
  name: string;
}

export interface FocusedDiagramLoadRequest {
  connectionId: string;
  database: string;
  catalog?: string;
  roots: DiagramTableIdentity[];
  concurrency?: number;
  onProgress?: (loaded: number, discovered: number) => void;
}

export interface FocusedDiagramLoadResult {
  tables: DiagramTable[];
  rootKeys: string[];
}

export interface DiagramMetadataAdapter {
  getColumns(table: DiagramTableIdentity): Promise<ColumnInfo[]>;
  listForeignKeys(table: DiagramTableIdentity): Promise<ForeignKeyInfo[]>;
  listIndexes(table: DiagramTableIdentity): Promise<IndexInfo[]>;
  getTableComment?(table: DiagramTableIdentity): Promise<string | null>;
}

/** JSON tuples preserve case and cannot collide on dots in quoted identifiers. */
export function diagramIdentityKey(table: { schema?: string; name: string }): string {
  return JSON.stringify([table.schema ?? "", table.name]);
}

export function normalizedDiagramRoots(roots: DiagramTableIdentity[]): DiagramTableIdentity[] {
  return [...new Map(roots.filter((root) => root.name.trim()).map((root) => [diagramIdentityKey(root), { ...root }])).values()].sort(compareIdentities);
}

function compareIdentities(a: DiagramTableIdentity, b: DiagramTableIdentity): number {
  return a.schema < b.schema ? -1 : a.schema > b.schema ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Keep the same editable index representation used by the structure inspector. */
export function diagramIndexes(indexes: IndexInfo[]): DiagramTable["indexes"] {
  return indexes.map((index) => ({
    id: index.name,
    name: index.name,
    columns: [...index.columns],
    isUnique: index.is_unique,
    isPrimary: index.is_primary,
    filter: index.filter ?? "",
    indexType: index.index_type ?? "",
    includedColumns: index.included_columns ?? [],
    comment: index.comment ?? "",
    markedForDrop: false,
    original: index,
  }));
}

/** Bounded breadth-first outbound traversal. Required metadata errors reject the closure. */
export async function loadFocusedDiagram(request: FocusedDiagramLoadRequest, metadata: DiagramMetadataAdapter): Promise<FocusedDiagramLoadResult> {
  const roots = normalizedDiagramRoots(request.roots);
  const rootKeys = roots.map(diagramIdentityKey);
  const discovered = new Set(rootKeys);
  const pending = [...roots];
  const tables: DiagramTable[] = [];
  const concurrency = Number.isFinite(request.concurrency) ? Math.max(1, Math.floor(request.concurrency!)) : 4;
  request.onProgress?.(0, discovered.size);
  while (pending.length) {
    const batch = pending.splice(0, concurrency);
    const batchTables = await Promise.all(
      batch.map(async (table) => {
        const [columns, foreignKeys, indexes, comment] = await Promise.all([metadata.getColumns(table), metadata.listForeignKeys(table), metadata.listIndexes(table), metadata.getTableComment?.(table).catch(() => null) ?? null]);
        return { ...table, columns, foreignKeys, indexes: diagramIndexes(indexes), comment };
      }),
    );
    for (const table of batchTables) {
      tables.push(table);
      for (const fk of table.foreignKeys) {
        const target = { schema: fk.ref_schema || table.schema, name: fk.ref_table };
        const key = diagramIdentityKey(target);
        if (!discovered.has(key)) {
          discovered.add(key);
          pending.push(target);
        }
      }
    }
    request.onProgress?.(tables.length, discovered.size);
  }
  tables.sort((a, b) => compareIdentities({ schema: a.schema ?? "", name: a.name }, { schema: b.schema ?? "", name: b.name }));
  return { tables, rootKeys };
}
