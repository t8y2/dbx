import type { ConnectionConfig, TreeNode } from "@/types/database";
import { effectiveDatabaseTypeForConnection } from "./jdbcDialect";

export const POSTGRES_SYSTEM_CATEGORIES = ["accessMethods", "encodings", "collations", "languages", "extensions"] as const;
export type PostgresSystemCategory = (typeof POSTGRES_SYSTEM_CATEGORIES)[number];

export function supportsPostgresAdministration(connection?: ConnectionConfig): boolean {
  return !!connection && effectiveDatabaseTypeForConnection(connection) === "postgres" && connection.driver_profile !== "cockroachdb";
}

/** Cache payloads remain flat. Only the sidebar projection introduces groups. */
export function unwrapPostgresConnectionChildren(children: readonly TreeNode[]): TreeNode[] {
  return children.flatMap((child) => (child.type === "postgres-databases" ? (child.children ?? []) : child.type === "postgres-admin" || child.type === "postgres-info" ? [] : [child]));
}

export function postgresConnectionChildren(connection: ConnectionConfig, children: TreeNode[], previous: readonly TreeNode[] = []): TreeNode[] {
  if (!supportsPostgresAdministration(connection)) return children;
  const flat = unwrapPostgresConnectionChildren(children);
  const group = (type: "postgres-databases" | "postgres-admin" | "postgres-info", label: string, nodes: TreeNode[], expanded = false): TreeNode => ({
    id: `${connection.id}:__${type}`,
    type,
    label: `postgresAdmin.${label}`,
    connectionId: connection.id,
    isExpanded: previous.find((node) => node.type === type)?.isExpanded ?? expanded,
    children: nodes,
  });
  const tool = (name: string, type: "postgres-sessions" | "postgres-locks" | "postgres-status" | "postgres-info-category", category?: PostgresSystemCategory): TreeNode => ({
    id: `${connection.id}:__pg_${category ?? type}`,
    type,
    label: `postgresAdmin.${name}`,
    connectionId: connection.id,
    ...(category ? { postgresSystemCategory: category } : {}),
    isExpanded: false,
  });
  return [
    group(
      "postgres-databases",
      "databases",
      flat.filter((node) => node.type === "database"),
      true,
    ),
    group("postgres-admin", "administration", [tool("sessions", "postgres-sessions"), tool("locks", "postgres-locks"), tool("status", "postgres-status")]),
    group(
      "postgres-info",
      "systemInfo",
      POSTGRES_SYSTEM_CATEGORIES.map((category) => tool(category, "postgres-info-category", category)),
    ),
    ...flat.filter((node) => node.type !== "database"),
  ];
}
