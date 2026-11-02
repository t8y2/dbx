import type { ConnectionConfig, TreeNode } from "@/types/database";
import { connectionUsesConnectionRootSchemaMode } from "@/lib/database/jdbcDialect";

/**
 * Whether a sidebar tree node represents the connection's own login user.
 *
 * This is only meaningful for the Oracle-family engines whose connection-root
 * schemas *are* database users (Oracle, Dameng, OceanBase in Oracle mode). For
 * those connections the schema tree is a flat list of user schemas, one of
 * which is the account the connection logged in as. Highlighting it lets a user
 * with many schemas immediately see "which one is me" (issue #7490).
 *
 * The comparison mirrors `filterSchemaNamesForVisiblePicker` in
 * `visibleDatabases.ts`, which already equates `connection.username` with the
 * current user schema case-insensitively. Oracle/Dameng fold unquoted
 * identifiers to upper case, so a `test01` login surfaces as a `TEST01` schema
 * node; the lower-cased compare keeps those matched without inventing a new
 * identifier-normalization framework.
 *
 * Databases where a schema is not a user (PostgreSQL's `public`, a MySQL
 * database that happens to share the login name, every `treeSchema` engine)
 * never reach the connection-root-schema branch, so a coincidental name clash
 * is not mistaken for the login user.
 */
export function isLoginUserSchemaNode(node: Pick<TreeNode, "type" | "schema" | "label">, config: Pick<ConnectionConfig, "db_type" | "driver_profile" | "username"> | undefined): boolean {
  if (node.type !== "schema") return false;
  if (!connectionUsesConnectionRootSchemaMode(config)) return false;
  const username = config?.username?.trim().toLowerCase();
  if (!username) return false;
  const schemaName = (node.schema ?? node.label ?? "").trim().toLowerCase();
  return schemaName.length > 0 && schemaName === username;
}
