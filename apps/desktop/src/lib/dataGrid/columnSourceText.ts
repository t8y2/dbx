export interface DataGridColumnSourceRef {
  schema?: string | null;
  tableName?: string | null;
  sourceColumn?: string | null;
}

/** `schema.table.column` for the column header tooltip, or undefined when the result has no source table. */
export function dataGridColumnSourceText(source: DataGridColumnSourceRef | undefined): string | undefined {
  if (!source?.tableName) return undefined;
  return [source.schema, source.tableName, source.sourceColumn].filter(Boolean).join(".");
}
