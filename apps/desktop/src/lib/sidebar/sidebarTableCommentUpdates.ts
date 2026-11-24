import type { TableInfo } from "@/types/database";
import { normalizeSidebarObjectKind } from "@/lib/database/databaseObjectCapabilities";
import type { TableSearchIndex } from "@/lib/metadata/schemaTreeCache";
import type { SidebarRegexIndexScope, SidebarRegexScopeIdentity } from "@/lib/sidebar/sidebarSearchTree";

export interface SidebarTableCommentUpdate {
  revision: number;
  connectionId: string;
  database: string;
  schema?: string;
  catalog?: string;
  tableName: string;
  comment: string | null;
}

type CommentScope = Pick<SidebarRegexScopeIdentity, "connectionId" | "database" | "schema" | "catalog">;

function matchesTable(scope: CommentScope, name: string, type: string, schema: string | null | undefined, update: SidebarTableCommentUpdate): boolean {
  return scope.connectionId === update.connectionId && scope.database === update.database && scope.catalog === update.catalog && (schema ?? scope.schema) === update.schema && name.trim() === update.tableName && normalizeSidebarObjectKind(type) === "TABLE";
}

function latestMatchingUpdate(scope: CommentScope, name: string, type: string, schema: string | null | undefined, updates: readonly SidebarTableCommentUpdate[]): SidebarTableCommentUpdate | undefined {
  for (let index = updates.length - 1; index >= 0; index--) {
    if (matchesTable(scope, name, type, schema, updates[index]!)) return updates[index];
  }
  return undefined;
}

export function patchSidebarTableComments(scope: CommentScope, entries: TableInfo[], updates: readonly SidebarTableCommentUpdate[]): TableInfo[] {
  let changed = false;
  const next = entries.map((entry) => {
    const update = latestMatchingUpdate(scope, entry.name, entry.table_type, entry.schema, updates);
    if (!update || entry.comment === update.comment) return entry;
    changed = true;
    return { ...entry, comment: update.comment };
  });
  return changed ? next : entries;
}

export function patchSidebarTableCommentScopes(scopes: SidebarRegexIndexScope[], updates: readonly SidebarTableCommentUpdate[]): SidebarRegexIndexScope[] {
  return scopes.map((scope) => {
    const entries = patchSidebarTableComments(scope, scope.entries, updates);
    return entries === scope.entries ? scope : { ...scope, entries };
  });
}

export function patchSidebarTableCommentIndex(scope: CommentScope, index: TableSearchIndex, updates: readonly SidebarTableCommentUpdate[]): TableSearchIndex {
  let changed = false;
  const entries = index.entries.map((entry) => {
    const update = latestMatchingUpdate(scope, entry.name, entry.tableType, entry.schema, updates);
    if (!update || entry.comment === update.comment) return entry;
    changed = true;
    return { ...entry, comment: update.comment };
  });
  return changed ? { ...index, entries } : index;
}

/** Keep updates only for reads already in progress. A later database refresh
 * must be allowed to report another change instead of inheriting an overlay. */
export function createSidebarTableCommentUpdates() {
  const pending = new Set<Map<string, SidebarTableCommentUpdate>>();
  return {
    record(update: SidebarTableCommentUpdate) {
      const key = JSON.stringify([update.connectionId, update.database, update.schema, update.catalog, update.tableName]);
      for (const updates of pending) updates.set(key, update);
    },
    begin() {
      const updates = new Map<string, SidebarTableCommentUpdate>();
      pending.add(updates);
      return {
        patchEntries: (scope: CommentScope, entries: TableInfo[]) => patchSidebarTableComments(scope, entries, [...updates.values()]),
        patchScopes: (scopes: SidebarRegexIndexScope[]) => patchSidebarTableCommentScopes(scopes, [...updates.values()]),
        patchIndex: (scope: CommentScope, index: TableSearchIndex) => patchSidebarTableCommentIndex(scope, index, [...updates.values()]),
        finish: () => pending.delete(updates),
      };
    },
  };
}
