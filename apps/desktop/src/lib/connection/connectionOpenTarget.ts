import type { ConnectionConfig } from "@/types/database";
import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";

export type QuickConnectionOpenTarget = { kind: "mq-admin" } | { kind: "nacos-admin" } | { kind: "etcd" } | { kind: "zookeeper" } | { kind: "query"; database: string };

export function quickConnectionOpenTarget(connection: Pick<ConnectionConfig, "db_type" | "database">, databaseOptions: string[] = []): QuickConnectionOpenTarget {
  if (connection.db_type === "mq") {
    return { kind: "mq-admin" };
  }
  if (connection.db_type === "nacos") {
    return { kind: "nacos-admin" };
  }
  if (connection.db_type === "etcd") {
    return { kind: "etcd" };
  }
  if (connection.db_type === "zookeeper") {
    return { kind: "zookeeper" };
  }
  return { kind: "query", database: resolveDefaultDatabase(connection, databaseOptions) };
}
