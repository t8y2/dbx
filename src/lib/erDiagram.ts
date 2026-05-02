import type { ColumnInfo, ForeignKeyInfo } from "../types/database";

export interface DiagramTable {
  name: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
}

export interface DiagramRelationship {
  id: string;
  name: string;
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
}

export interface DiagramPosition {
  x: number;
  y: number;
}

export interface DiagramLayoutOptions {
  columnsPerRow?: number;
  cardWidth?: number;
  rowHeight?: number;
  gapX?: number;
  gapY?: number;
  margin?: number;
}

function relationshipId(sourceTable: string, fk: ForeignKeyInfo): string {
  return [
    sourceTable,
    fk.name || "foreign_key",
    fk.column,
    fk.ref_table,
    fk.ref_column,
  ].join(":");
}

export function buildDiagramRelationships(tables: DiagramTable[]): DiagramRelationship[] {
  const visibleTableNames = new Set(tables.map((table) => table.name));

  return tables.flatMap((table) =>
    table.foreignKeys
      .filter((fk) => visibleTableNames.has(fk.ref_table))
      .map((fk) => ({
        id: relationshipId(table.name, fk),
        name: fk.name,
        sourceTable: table.name,
        sourceColumn: fk.column,
        targetTable: fk.ref_table,
        targetColumn: fk.ref_column,
      })),
  );
}

export function filterDiagramTables(tables: DiagramTable[], query: string): DiagramTable[] {
  const q = query.trim().toLowerCase();
  if (!q) return tables;

  return tables.filter((table) => {
    if (table.name.toLowerCase().includes(q)) return true;
    if (table.columns.some((column) =>
      column.name.toLowerCase().includes(q) ||
      column.data_type.toLowerCase().includes(q)
    )) return true;
    return table.foreignKeys.some((fk) =>
      fk.name.toLowerCase().includes(q) ||
      fk.column.toLowerCase().includes(q) ||
      fk.ref_table.toLowerCase().includes(q) ||
      fk.ref_column.toLowerCase().includes(q)
    );
  });
}

export function layoutDiagramTables(
  tables: Pick<DiagramTable, "name" | "columns">[],
  options: DiagramLayoutOptions = {},
): Record<string, DiagramPosition> {
  const columnsPerRow = Math.max(1, options.columnsPerRow ?? Math.ceil(Math.sqrt(Math.max(tables.length, 1))));
  const cardWidth = options.cardWidth ?? 260;
  const rowHeight = options.rowHeight ?? 220;
  const gapX = options.gapX ?? 56;
  const gapY = options.gapY ?? 40;
  const margin = options.margin ?? 40;

  return Object.fromEntries(tables.map((table, index) => {
    const col = index % columnsPerRow;
    const row = Math.floor(index / columnsPerRow);
    return [
      table.name,
      {
        x: margin + col * (cardWidth + gapX),
        y: margin + row * (rowHeight + gapY),
      },
    ];
  }));
}
