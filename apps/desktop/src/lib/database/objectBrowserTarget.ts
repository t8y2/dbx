import { connectionUsesConnectionRootSchemaMode, type JdbcDialectConnection } from "@/lib/database/jdbcDialect";

/**
 * Object-browser target for a row of the database/schema overview list.
 *
 * Engines that expose schemas directly below the connection (Oracle, Dameng,
 * OceanBase Oracle, and JDBC profiles inferred to them) list schemas in that
 * overview, so the clicked row must bind as both the database and the schema —
 * the same convention the sidebar uses when it locates a query context (see
 * ConnectionTree). Binding the row as a plain database instead opens the tab
 * under the connection default or the first schema, while the tab title keeps
 * showing the clicked name (#11795).
 *
 * Engines with a real database level (MySQL, PostgreSQL, ...) keep the row name
 * as the database and leave the schema to the browser's default selection.
 */
export function objectBrowserTargetForNamespaceRow(connection: JdbcDialectConnection | undefined, rowName: string): { database: string; schema?: string } {
  return connectionUsesConnectionRootSchemaMode(connection) ? { database: rowName, schema: rowName } : { database: rowName };
}
