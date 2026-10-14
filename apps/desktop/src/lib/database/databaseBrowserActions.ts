import { onBeforeUnmount } from "vue";
import { supportsDatabaseCreation } from "@/lib/database/databaseCapabilities";
import { supportsCreateDatabaseLocale } from "@/lib/database/createDatabaseSql";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import { isSqlServerLinkedNode } from "@/lib/database/sqlServerLinkedServers";
import type { ConnectionConfig, TreeNode } from "@/types/database";

export function canDropDatabaseNode(node: TreeNode, connection?: ConnectionConfig): boolean {
  return (
    node.type === "database" && !!node.connectionId && !!node.database && !node.catalog && !isSqlServerLinkedNode(node) && !connectionIsEffectivelyReadOnly(connection) && (supportsDatabaseCreation(connection?.db_type) || supportsCreateDatabaseLocale(connection?.db_type, connection?.driver_profile))
  );
}

export interface DatabaseBrowserMutation {
  connectionId: string;
  database: string;
  operation: "empty" | "drop-tables" | "drop-database";
}

const mutationEvent = "dbx-database-browser-mutation";

export function notifyDatabaseBrowserMutation(mutation: DatabaseBrowserMutation): void {
  window.dispatchEvent(new CustomEvent(mutationEvent, { detail: mutation }));
}

export function useDatabaseBrowserMutation(handler: (mutation: DatabaseBrowserMutation) => void): void {
  const listener = (event: Event) => handler((event as CustomEvent<DatabaseBrowserMutation>).detail);
  window.addEventListener(mutationEvent, listener);
  onBeforeUnmount(() => window.removeEventListener(mutationEvent, listener));
}
