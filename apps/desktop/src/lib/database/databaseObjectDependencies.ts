import type { DatabaseType, TreeNode } from "@/types/database";
import { xuguDependencyProvider } from "@/lib/database/xuguObjectDependencies";

/**
 * The subset of a sidebar node needed by a database dependency provider.
 * Keeping this contract small lets providers remain independent of Vue state
 * and makes it possible to test them without constructing a full tree node.
 */
export type DependencyTreeNode = Pick<TreeNode, "type" | "schema" | "objectName" | "label" | "parentType" | "parentName">;

/**
 * Database-specific dependency inspection contract.
 *
 * Providers own catalog SQL and object-type mappings. The sidebar only asks
 * whether a node is supported and executes the returned read-only query.
 */
export interface DatabaseDependencyProvider {
  readonly databaseType: DatabaseType;
  supports(node: DependencyTreeNode): boolean;
  buildQuery(node: DependencyTreeNode): string | null;
}

const PROVIDERS: Partial<Record<DatabaseType, DatabaseDependencyProvider>> = {
  xugu: xuguDependencyProvider,
};

export function databaseDependencyProviderFor(databaseType?: DatabaseType): DatabaseDependencyProvider | null {
  return databaseType ? (PROVIDERS[databaseType] ?? null) : null;
}

export function canViewDatabaseObjectDependencies(databaseType: DatabaseType | undefined, node: DependencyTreeNode): boolean {
  return databaseDependencyProviderFor(databaseType)?.supports(node) ?? false;
}
