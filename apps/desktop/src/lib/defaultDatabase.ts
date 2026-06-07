import type { ConnectionConfig } from "@/types/database";

export function resolveDefaultDatabase(connection: Pick<ConnectionConfig, "database">, options: string[]): string {
  return connection.database || options[0] || "";
}

export function isDefaultDatabase(
  connection: Pick<ConnectionConfig, "database"> | undefined,
  database: string,
): boolean {
  return !!connection?.database && !!database && connection.database === database;
}
