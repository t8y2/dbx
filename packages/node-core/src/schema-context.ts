import type { ConnectionConfig } from "./connections.js";
import type { ColumnInfo, TableInfo } from "./database.js";

export interface SchemaContextBackend {
  listTables(config: ConnectionConfig, schema?: string): Promise<TableInfo[]>;
  describeTable(config: ConnectionConfig, table: string, schema?: string): Promise<ColumnInfo[]>;
}

export interface SchemaContextOptions {
  schema?: string;
  tables?: string[];
  maxTables?: number;
}

export interface SchemaContextTable {
  name: string;
  type: string;
  columns: ColumnInfo[];
}

export interface SchemaContext {
  connection: string;
  database: string;
  schema: string;
  truncated: boolean;
  tables: SchemaContextTable[];
}

const DEFAULT_MAX_TABLES = 8;

export async function buildSchemaContext(backend: SchemaContextBackend, config: ConnectionConfig, options: SchemaContextOptions = {}): Promise<SchemaContext> {
  const maxTables = Math.max(1, Math.min(options.maxTables ?? DEFAULT_MAX_TABLES, 20));
  const availableTables = await backend.listTables(config, options.schema);
  const requested = new Set((options.tables ?? []).map((table) => table.toLowerCase()));
  const selected = requested.size ? availableTables.filter((table) => requested.has(table.name.toLowerCase())) : availableTables.slice(0, maxTables);

  const limited = selected.slice(0, maxTables);
  const tables = await Promise.all(
    limited.map(async (table) => ({
      name: table.name,
      type: table.type,
      columns: await backend.describeTable(config, table.name, options.schema),
    })),
  );

  return {
    connection: config.name,
    database: config.database || "",
    schema: options.schema || "",
    truncated: selected.length > limited.length || (!requested.size && availableTables.length > limited.length),
    tables,
  };
}

export function formatSchemaContext(context: SchemaContext): string {
  const header = [`Connection: ${context.connection}`, context.database ? `Database: ${context.database}` : "", context.schema ? `Schema: ${context.schema}` : ""].filter(Boolean);
  const sections = context.tables.map((table) => {
    const lines = table.columns.map((column) => {
      const parts = [column.name, column.data_type, column.is_nullable ? "NULL" : "NOT NULL", column.is_primary_key ? "PK" : ""].filter(Boolean);
      return `- ${parts.join(" ")}${column.comment ? ` -- ${column.comment}` : ""}`;
    });
    return [`## ${table.name}`, `Type: ${table.type}`, ...lines].join("\n");
  });
  const suffix = context.truncated ? "\n\nNote: table list was truncated; request specific table names for more context." : "";
  return `${header.join("\n")}\n\n${sections.join("\n\n")}${suffix}`;
}
