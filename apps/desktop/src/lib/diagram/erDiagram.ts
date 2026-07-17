import type { ColumnInfo, ForeignKeyInfo } from "@/types/database";

export interface DiagramTable {
  name: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
}

export interface DiagramRelationship {
  id: string;
  name: string;
  kind: "foreign-key" | "custom";
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
  sourceCardinality: "1" | "N";
  targetCardinality: "1" | "N";
}

export interface CustomDiagramRelationship {
  id: string;
  name: string;
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
  sourceCardinality: "1" | "N";
  targetCardinality: "1" | "N";
}

export interface DiagramJoinSqlOptions {
  joinType?: "INNER JOIN" | "LEFT JOIN";
  rootTable?: string;
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
  return [sourceTable, fk.name || "foreign_key", fk.column, fk.ref_table, fk.ref_column].join(":");
}

function columnExists(table: DiagramTable | undefined, columnName: string): boolean {
  return !!table?.columns.some((column) => column.name === columnName);
}

function customRelationshipId(relationship: Omit<CustomDiagramRelationship, "id">): string {
  return ["custom", relationship.sourceTable, relationship.sourceColumn, relationship.targetTable, relationship.targetColumn, relationship.sourceCardinality, relationship.targetCardinality].join(":");
}

export function normalizeCustomDiagramRelationship(input: Omit<CustomDiagramRelationship, "id"> & { id?: string }): CustomDiagramRelationship {
  return {
    ...input,
    id: input.id || customRelationshipId(input),
  };
}

export function buildDiagramRelationships(tables: DiagramTable[], customRelationships: CustomDiagramRelationship[] = []): DiagramRelationship[] {
  const visibleTableNames = new Set(tables.map((table) => table.name));
  const tableMap = new Map(tables.map((table) => [table.name, table]));

  const foreignKeyRelationships = tables.flatMap((table) =>
    table.foreignKeys
      .filter((fk) => visibleTableNames.has(fk.ref_table))
      .map((fk) => ({
        id: relationshipId(table.name, fk),
        name: fk.name,
        kind: "foreign-key" as const,
        sourceTable: table.name,
        sourceColumn: fk.column,
        targetTable: fk.ref_table,
        targetColumn: fk.ref_column,
        sourceCardinality: "N" as const,
        targetCardinality: "1" as const,
      })),
  );

  const custom = customRelationships
    .filter((relationship) => visibleTableNames.has(relationship.sourceTable) && visibleTableNames.has(relationship.targetTable))
    .filter((relationship) => columnExists(tableMap.get(relationship.sourceTable), relationship.sourceColumn) && columnExists(tableMap.get(relationship.targetTable), relationship.targetColumn))
    .map((relationship) => ({
      ...relationship,
      kind: "custom" as const,
    }));

  return [...foreignKeyRelationships, ...custom];
}

export function filterDiagramTables(tables: DiagramTable[], query: string): DiagramTable[] {
  const q = query.trim().toLowerCase();
  if (!q) return tables;

  return tables.filter((table) => {
    if (table.name.toLowerCase().includes(q)) return true;
    if (table.columns.some((column) => column.name.toLowerCase().includes(q) || column.data_type.toLowerCase().includes(q))) return true;
    return table.foreignKeys.some((fk) => fk.name.toLowerCase().includes(q) || fk.column.toLowerCase().includes(q) || fk.ref_table.toLowerCase().includes(q) || fk.ref_column.toLowerCase().includes(q));
  });
}

export function layoutDiagramTables(tables: Pick<DiagramTable, "name" | "columns">[], options: DiagramLayoutOptions = {}): Record<string, DiagramPosition> {
  const columnsPerRow = Math.max(1, options.columnsPerRow ?? Math.ceil(Math.sqrt(Math.max(tables.length, 1))));
  const cardWidth = options.cardWidth ?? 260;
  const rowHeight = options.rowHeight ?? 220;
  const gapX = options.gapX ?? 56;
  const gapY = options.gapY ?? 40;
  const margin = options.margin ?? 40;

  return Object.fromEntries(
    tables.map((table, index) => {
      const col = index % columnsPerRow;
      const row = Math.floor(index / columnsPerRow);
      return [
        table.name,
        {
          x: margin + col * (cardWidth + gapX),
          y: margin + row * (rowHeight + gapY),
        },
      ];
    }),
  );
}

function quoteIdentifier(value: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function relationshipCondition(relationship: DiagramRelationship, aliases: Map<string, string>): string {
  const sourceAlias = aliases.get(relationship.sourceTable) ?? quoteIdentifier(relationship.sourceTable);
  const targetAlias = aliases.get(relationship.targetTable) ?? quoteIdentifier(relationship.targetTable);
  return `${sourceAlias}.${quoteIdentifier(relationship.sourceColumn)} = ${targetAlias}.${quoteIdentifier(relationship.targetColumn)}`;
}

function nextJoinableRelationship(relationships: DiagramRelationship[], joinedTables: Set<string>, consumedRelationships: Set<string>): DiagramRelationship | undefined {
  return relationships.find((relationship) => {
    if (consumedRelationships.has(relationship.id)) return false;
    const sourceJoined = joinedTables.has(relationship.sourceTable);
    const targetJoined = joinedTables.has(relationship.targetTable);
    return sourceJoined !== targetJoined || (!sourceJoined && !targetJoined && joinedTables.size === 0);
  });
}

export function buildDiagramJoinSql(relationships: DiagramRelationship[], options: DiagramJoinSqlOptions = {}): string {
  const joinableRelationships = relationships.filter((relationship) => relationship.sourceTable && relationship.sourceColumn && relationship.targetTable && relationship.targetColumn);
  if (joinableRelationships.length === 0) return "";

  const joinType = options.joinType ?? "LEFT JOIN";
  const rootTable = options.rootTable && joinableRelationships.some((relationship) => relationship.sourceTable === options.rootTable || relationship.targetTable === options.rootTable) ? options.rootTable : joinableRelationships[0].sourceTable;
  const joinedTables = new Set<string>([rootTable]);
  const aliases = new Map<string, string>([[rootTable, "t1"]]);
  const consumedRelationships = new Set<string>();
  const joinLines: string[] = [];

  while (consumedRelationships.size < joinableRelationships.length) {
    const relationship = nextJoinableRelationship(joinableRelationships, joinedTables, consumedRelationships);
    if (!relationship) break;

    const sourceJoined = joinedTables.has(relationship.sourceTable);
    const targetJoined = joinedTables.has(relationship.targetTable);
    const tableToJoin = sourceJoined && !targetJoined ? relationship.targetTable : relationship.sourceTable;
    if (!joinedTables.has(tableToJoin)) {
      const previousJoinedTables = new Set(joinedTables);
      aliases.set(tableToJoin, `t${aliases.size + 1}`);
      joinedTables.add(tableToJoin);
      const joinConditions = joinableRelationships.filter((item) => !consumedRelationships.has(item.id) && ((item.sourceTable === tableToJoin && previousJoinedTables.has(item.targetTable)) || (item.targetTable === tableToJoin && previousJoinedTables.has(item.sourceTable))));
      joinConditions.forEach((item) => consumedRelationships.add(item.id));
      joinLines.push(`${joinType} ${quoteIdentifier(tableToJoin)} ${aliases.get(tableToJoin)} ON ${joinConditions.map((item) => relationshipCondition(item, aliases)).join(" AND ")}`);
    }
    consumedRelationships.add(relationship.id);
  }

  const whereRelationships = joinableRelationships.filter((relationship) => !consumedRelationships.has(relationship.id) && joinedTables.has(relationship.sourceTable) && joinedTables.has(relationship.targetTable));
  whereRelationships.forEach((relationship) => consumedRelationships.add(relationship.id));
  const whereLine = whereRelationships.length > 0 ? `WHERE ${whereRelationships.map((relationship) => relationshipCondition(relationship, aliases)).join(" AND ")}` : "";
  const selectList = [...joinedTables].map((table) => `  ${aliases.get(table)}.*`).join(",\n");
  const disconnectedRelationships = joinableRelationships.filter((relationship) => !consumedRelationships.has(relationship.id));
  const disconnectedNotes = disconnectedRelationships.map((relationship) => `-- Disconnected relationship skipped: ${relationship.sourceTable}.${relationship.sourceColumn} = ${relationship.targetTable}.${relationship.targetColumn}`);

  return [`SELECT`, selectList, `FROM ${quoteIdentifier(rootTable)} ${aliases.get(rootTable)}`, ...joinLines, whereLine, ...disconnectedNotes].filter(Boolean).join("\n");
}
