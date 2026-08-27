import type { TableInfo } from "@/types/database";

export type SchemaDiffTableSide = "source" | "target";

export interface SchemaDiffTableIdentity {
  connectionId: string;
  database: string;
  schema: string;
}

export interface SchemaDiffTableListLoader {
  load(identity: SchemaDiffTableIdentity, options?: { refresh?: boolean }): Promise<TableInfo[]>;
}

interface SchemaDiffTableListLoaderDependencies {
  ensureConnected(connectionId: string): Promise<unknown>;
  listTables(connectionId: string, database: string, schema: string): Promise<TableInfo[]>;
}

interface SchemaDiffTableListCoordinatorOptions {
  loader: SchemaDiffTableListLoader;
  getIdentity(side: SchemaDiffTableSide): SchemaDiffTableIdentity;
  setTables(side: SchemaDiffTableSide, tables: TableInfo[]): void;
  onSourceTablesLoaded?(tables: TableInfo[]): void;
}

function identityKey(identity: SchemaDiffTableIdentity): string {
  return JSON.stringify([identity.connectionId, identity.database, identity.schema]);
}

export function sameSchemaDiffTableIdentity(left: SchemaDiffTableIdentity, right: SchemaDiffTableIdentity): boolean {
  return left.connectionId === right.connectionId && left.database === right.database && left.schema === right.schema;
}

export function shouldLoadSchemaDiffTableList(side: SchemaDiffTableSide, restricted: boolean, selectedTableCount: number, identityReady: boolean): boolean {
  return identityReady && restricted && (side === "source" || selectedTableCount > 0);
}

export function reconcileSchemaDiffSelectedTables(selectedTables: string[], availableTables: string[]): string[] {
  const available = new Set(availableTables);
  return selectedTables.filter((table) => available.has(table));
}

export function createSchemaDiffTableListLoader(dependencies: SchemaDiffTableListLoaderDependencies): SchemaDiffTableListLoader {
  const successful = new Map<string, TableInfo[]>();
  const pending = new Map<string, Promise<TableInfo[]>>();

  return {
    async load(identity, options) {
      const key = identityKey(identity);
      const inFlight = pending.get(key);
      if (inFlight) return inFlight;

      const cached = options?.refresh ? undefined : successful.get(key);
      if (cached) {
        await dependencies.ensureConnected(identity.connectionId);
        return cached;
      }

      const request = dependencies
        .ensureConnected(identity.connectionId)
        .then(() => dependencies.listTables(identity.connectionId, identity.database, identity.schema))
        .then((tables) => {
          const normalized = Array.isArray(tables) ? tables : [];
          successful.set(key, normalized);
          return normalized;
        })
        .finally(() => pending.delete(key));

      pending.set(key, request);
      return request;
    },
  };
}

export function createSchemaDiffTableListCoordinator(options: SchemaDiffTableListCoordinatorOptions) {
  const generations: Record<SchemaDiffTableSide, number> = { source: 0, target: 0 };

  return {
    async refresh(side: SchemaDiffTableSide, enabled: boolean): Promise<boolean> {
      const generation = ++generations[side];
      const identity = options.getIdentity(side);
      options.setTables(side, []);
      if (!enabled) return false;

      try {
        const tables = await options.loader.load(identity);
        if (generation !== generations[side] || !sameSchemaDiffTableIdentity(identity, options.getIdentity(side))) return false;

        options.setTables(side, tables);
        if (side === "source") options.onSourceTablesLoaded?.(tables);
        return true;
      } catch {
        if (generation === generations[side] && sameSchemaDiffTableIdentity(identity, options.getIdentity(side))) {
          options.setTables(side, []);
        }
        return false;
      }
    },
  };
}
