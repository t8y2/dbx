import type { ConnectionConfig, DatabaseStorageInfo, ObjectStatistics, TreeNode } from "@/types/database";

const sidebarTableStorageTypes = new Set<ConnectionConfig["db_type"]>(["mysql", "postgres", "sqlserver", "oracle", "clickhouse", "dameng", "gaussdb", "kingbase", "gbase"]);

export function supportsSidebarDatabaseStorage(connection: ConnectionConfig | undefined): boolean {
  return connection?.db_type === "postgres" && connection.driver_profile !== "cockroachdb";
}

export function supportsSidebarTableStorage(connection: ConnectionConfig | undefined): boolean {
  if (!connection || !sidebarTableStorageTypes.has(connection.db_type)) return false;
  if (connection.db_type === "gbase" && connection.driver_profile === "gbase8s") return false;
  return connection.db_type !== "postgres" || connection.driver_profile !== "cockroachdb";
}

export function sidebarDatabaseNames(nodes: readonly TreeNode[] | undefined): string[] {
  if (!nodes) return [];
  return nodes.flatMap((node) => (node.type === "database" && !node.catalog && node.database ? [node.database] : []));
}

export function applySidebarDatabaseStorage(nodes: readonly TreeNode[] | undefined, storage: readonly DatabaseStorageInfo[]): boolean {
  if (!nodes?.length || !storage.length) return false;
  const byName = new Map(storage.map((item) => [item.name, item.size_bytes] as const));
  let changed = false;
  for (const node of nodes) {
    if (node.type !== "database" || node.catalog || !node.database || !byName.has(node.database)) continue;
    const sizeBytes = byName.get(node.database) ?? null;
    if (node.sizeBytes === sizeBytes) continue;
    node.sizeBytes = sizeBytes;
    changed = true;
  }
  return changed;
}

export interface SidebarTableStorageScope {
  connectionId: string;
  database: string;
  schema: string;
}

export function sidebarTableStorageScopes(nodes: readonly TreeNode[]): SidebarTableStorageScope[] {
  const scopes = new Map<string, SidebarTableStorageScope>();
  for (const node of nodes) {
    if ((node.type !== "table" && node.type !== "materialized_view") || !node.connectionId || !node.database) continue;
    const scope = { connectionId: node.connectionId, database: node.database, schema: node.schema || "" };
    scopes.set(`${scope.connectionId}\0${scope.database}\0${scope.schema}`, scope);
  }
  return [...scopes.values()];
}

export function applySidebarTableStorage(nodes: readonly TreeNode[] | undefined, scope: SidebarTableStorageScope, statistics: readonly ObjectStatistics[]): boolean {
  if (!nodes?.length || !statistics.length) return false;
  const sizeByName = new Map(statistics.filter((item) => !scope.schema || !item.schema || item.schema === scope.schema).map((item) => [item.name, item.total_bytes ?? null] as const));
  let changed = false;
  const visit = (items: readonly TreeNode[]) => {
    for (const node of items) {
      if ((node.type === "table" || node.type === "materialized_view") && node.connectionId === scope.connectionId && node.database === scope.database && (node.schema || "") === scope.schema && sizeByName.has(node.label)) {
        const sizeBytes = sizeByName.get(node.label) ?? null;
        if (node.sizeBytes !== sizeBytes) {
          node.sizeBytes = sizeBytes;
          changed = true;
        }
      }
      if (node.children?.length) visit(node.children);
      if (node.hiddenChildren?.length) visit(node.hiddenChildren);
    }
  };
  visit(nodes);
  return changed;
}

export function formatSidebarObjectStorage(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  const fractionDigits = unitIndex === 0 || size >= 100 ? 0 : size >= 10 ? 1 : 2;
  const rounded = size.toFixed(fractionDigits);
  const displaySize = rounded.includes(".") ? rounded.replace(/0+$/, "").replace(/\.$/, "") : rounded;
  return `${displaySize} ${units[unitIndex]}`;
}
