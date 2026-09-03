import type { ColumnInfo, ForeignKeyInfo, IndexInfo } from "@/types/database";
import type { EditableStructureIndex } from "@/lib/table/tableStructureEditorSql";

export type DiagramTableOrigin = "live" | "draft";

/** Live metadata (`IndexInfo`) or draft editor indexes (`EditableStructureIndex`). */
export type DiagramTableIndex = IndexInfo | EditableStructureIndex;

export function isEditableStructureIndex(index: DiagramTableIndex): index is EditableStructureIndex {
  return "isUnique" in index || "markedForDrop" in index;
}

export function editableStructureIndexes(table: DiagramTable): EditableStructureIndex[] {
  return (table.indexes ?? []).filter(isEditableStructureIndex);
}

export interface DiagramTable {
  name: string;
  schema?: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  /** Unique/PK indexes used for FK cardinality; drafts also sync via buildCreateTableSql */
  indexes?: DiagramTableIndex[];
  /** live = from DB metadata; draft = local design not yet synced */
  origin?: DiagramTableOrigin;
  syncStatus?: "pending" | "synced" | "error";
  /**
   * Live tables only: column names not yet in DB (subset of `columns`).
   * Editable in Inspector; synced via ALTER ADD COLUMN.
   */
  pendingColumnNames?: string[];
  /**
   * Live tables only: existing column names marked for DROP COLUMN on sync.
   * Columns remain in `columns` until sync/reload.
   */
  droppedColumnNames?: string[];
  /** Live tables only: marked for DROP TABLE on sync (hidden from canvas). */
  pendingDrop?: boolean;
}

export function isDraftTable(table: DiagramTable): boolean {
  return (table.origin ?? "live") === "draft";
}

export function isLiveTable(table: DiagramTable): boolean {
  return !isDraftTable(table);
}

export function hasPendingColumns(table: DiagramTable): boolean {
  return (table.pendingColumnNames?.length ?? 0) > 0;
}

export function isPendingColumn(table: DiagramTable, columnName: string): boolean {
  return (table.pendingColumnNames ?? []).some((name) => name === columnName);
}

export function hasDroppedColumns(table: DiagramTable): boolean {
  return (table.droppedColumnNames?.length ?? 0) > 0;
}

export function isDroppedColumn(table: DiagramTable, columnName: string): boolean {
  return (table.droppedColumnNames ?? []).some((name) => name === columnName);
}

/** Tables that need sync: draft creates, live column adds/drops, or pending DROP TABLE. */
export function needsDiagramSync(table: DiagramTable): boolean {
  return isDraftTable(table) || hasPendingColumns(table) || hasDroppedColumns(table) || !!table.pendingDrop;
}

/** Soft-deleted tables stay in state for Sync but must not be re-added to layers/canvas pickers. */
export function isDiagramTableAssignable(table: DiagramTable): boolean {
  return !table.pendingDrop;
}

export function filterAssignableDiagramTables(tables: DiagramTable[]): DiagramTable[] {
  return tables.filter(isDiagramTableAssignable);
}

export interface DiagramRelationship {
  id: string;
  name: string;
  kind: "foreign-key" | "custom" | "inferred";
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
  /** When set, every row advances by this height (legacy/tests). When omitted, row height follows tallest table in the row. */
  rowHeight?: number;
  gapX?: number;
  gapY?: number;
  margin?: number;
}

export function diagramTableId(table: { name: string; schema?: string }, isMultiSchema = false): string {
  return isMultiSchema && table.schema ? `${table.schema}.${table.name}` : table.name;
}

function relationshipId(sourceId: string, fk: ForeignKeyInfo, targetId?: string): string {
  return [sourceId, fk.name || "foreign_key", fk.column, targetId || fk.ref_table, fk.ref_column].join(":");
}

function columnExists(table: DiagramTable | undefined, columnName: string): boolean {
  return !!table?.columns.some((column) => column.name === columnName);
}

/** True when every unique-key column appears among the FK source columns (unique ⊆ FK). */
function sourceColumnsContainUniqueKey(sourceColumns: string[], keyColumns: string[]): boolean {
  if (keyColumns.length === 0) return false;
  const sourceColumnSet = new Set(sourceColumns);
  return keyColumns.every((column) => sourceColumnSet.has(column));
}

function foreignKeySourceColumns(table: DiagramTable, foreignKey: ForeignKeyInfo): string[] {
  if (!foreignKey.name) return [foreignKey.column];
  return table.foreignKeys.filter((candidate) => candidate.name === foreignKey.name && candidate.ref_table === foreignKey.ref_table).map((candidate) => candidate.column);
}

function diagramIndexIsUnique(index: DiagramTableIndex): boolean {
  if ("isUnique" in index) return !!(index.isUnique || index.isPrimary);
  return !!(index.is_unique || index.is_primary);
}

function diagramIndexFilter(index: DiagramTableIndex): string {
  return (index.filter ?? "").trim();
}

function diagramIndexMarkedForDrop(index: DiagramTableIndex): boolean {
  return "markedForDrop" in index && !!index.markedForDrop;
}

export function foreignKeySourceCardinality(table: DiagramTable, foreignKey: ForeignKeyInfo): "1" | "N" {
  const sourceColumns = foreignKeySourceColumns(table, foreignKey);
  const primaryKeyColumns = table.columns.filter((column) => column.is_primary_key).map((column) => column.name);
  if (sourceColumnsContainUniqueKey(sourceColumns, primaryKeyColumns)) return "1";

  if (sourceColumns.length === 1) {
    const col = table.columns.find((column) => column.name === sourceColumns[0]);
    if (col?.is_unique) return "1";
  }

  const hasUniqueIndex = (table.indexes ?? []).some((index) => diagramIndexIsUnique(index) && !diagramIndexFilter(index) && !diagramIndexMarkedForDrop(index) && sourceColumnsContainUniqueKey(sourceColumns, index.columns));
  return hasUniqueIndex ? "1" : "N";
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

export function buildDiagramRelationships(tables: DiagramTable[], customRelationships: CustomDiagramRelationship[] = [], isMultiSchema = false): DiagramRelationship[] {
  const tableIdMap = new Map(tables.map((table) => [diagramTableId(table, isMultiSchema), table]));
  const tableBySchemaAndName = new Map<string, DiagramTable>();
  const tableByName = new Map<string, DiagramTable>();
  for (const table of tables) {
    const schemaAndNameKey = `${table.schema ?? ""}\0${table.name}`;
    if (!tableBySchemaAndName.has(schemaAndNameKey)) tableBySchemaAndName.set(schemaAndNameKey, table);
    if (!tableByName.has(table.name)) tableByName.set(table.name, table);
  }

  const foreignKeyRelationships = tables.flatMap((table) => {
    const sourceId = diagramTableId(table, isMultiSchema);
    return table.foreignKeys
      .map((fk): DiagramRelationship | null => {
        let targetTable: DiagramTable | undefined;
        if (fk.ref_schema) {
          // Specified ref_schema: only match target within that schema
          targetTable = tableBySchemaAndName.get(`${fk.ref_schema}\0${fk.ref_table}`);
        } else if (table.schema) {
          // No ref_schema but source table has schema: only match target in the same schema
          targetTable = tableBySchemaAndName.get(`${table.schema}\0${fk.ref_table}`);
          // In multi-schema mode, do not blindly fall back across other schemas
        } else if (!isMultiSchema) {
          // Single-schema mode without schema qualification: fall back to bare table name
          targetTable = tableByName.get(fk.ref_table);
        }
        if (!targetTable) return null;

        const targetId = diagramTableId(targetTable, isMultiSchema);
        return {
          id: relationshipId(sourceId, fk, targetId),
          name: fk.name,
          kind: "foreign-key" as const,
          sourceTable: sourceId,
          sourceColumn: fk.column,
          targetTable: targetId,
          targetColumn: fk.ref_column,
          sourceCardinality: foreignKeySourceCardinality(table, fk),
          targetCardinality: "1" as const,
        };
      })
      .filter((rel): rel is DiagramRelationship => rel !== null);
  });

  // Custom relationships may reference tables by plain name or composite `schema.table` id
  // (match panel uses the latter); normalize both to the canvas node id.
  const custom = customRelationships.flatMap((relationship) => {
    const sourceTable = tableIdMap.get(relationship.sourceTable) ?? tables.find((t) => t.name === relationship.sourceTable);
    const targetTable = tableIdMap.get(relationship.targetTable) ?? tables.find((t) => t.name === relationship.targetTable);
    if (!sourceTable || !targetTable) return [];
    if (!columnExists(sourceTable, relationship.sourceColumn) || !columnExists(targetTable, relationship.targetColumn)) return [];
    return [
      {
        ...relationship,
        sourceTable: diagramTableId(sourceTable, isMultiSchema),
        targetTable: diagramTableId(targetTable, isMultiSchema),
        kind: "custom" as const,
      },
    ];
  });

  return deduplicateRelationships([...foreignKeyRelationships, ...custom]);
}

export function deduplicateRelationships(relationships: DiagramRelationship[]): DiagramRelationship[] {
  const seen = new Set<string>();
  const unique: DiagramRelationship[] = [];

  for (const rel of relationships) {
    const key = `${rel.sourceTable}:${rel.sourceColumn}:${rel.targetTable}:${rel.targetColumn}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(rel);
    }
  }

  return unique;
}

export interface InferredRelationshipInput {
  id: string;
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
  confidence?: "high" | "medium";
  strategy?: string;
}

export function toDiagramRelationship(input: InferredRelationshipInput): DiagramRelationship {
  return {
    id: input.id,
    name: `${input.sourceTable}_${input.sourceColumn}_${input.targetTable}_${input.targetColumn}`,
    kind: "inferred",
    sourceTable: input.sourceTable,
    sourceColumn: input.sourceColumn,
    targetTable: input.targetTable,
    targetColumn: input.targetColumn,
    sourceCardinality: "N",
    targetCardinality: "1",
  };
}

export function mergeRelationshipsWithInferred(existing: DiagramRelationship[], inferred: InferredRelationshipInput[]): DiagramRelationship[] {
  const existingIds = new Set(existing.map((r) => r.id));
  const merged: DiagramRelationship[] = [...existing];

  for (const inf of inferred) {
    if (!existingIds.has(inf.id)) {
      merged.push(toDiagramRelationship(inf));
      existingIds.add(inf.id);
    }
  }

  return deduplicateRelationships(merged);
}

export function filterDiagramTables(tables: DiagramTable[], query: string): DiagramTable[] {
  const q = query.trim().toLowerCase();
  if (!q) return tables;

  return tables.filter((table) => {
    if (table.schema?.toLowerCase().includes(q)) return true;
    if (table.name.toLowerCase().includes(q)) return true;
    if (table.schema && `${table.schema}.${table.name}`.toLowerCase().includes(q)) return true;
    if (table.columns.some((column) => column.name.toLowerCase().includes(q) || column.data_type.toLowerCase().includes(q))) return true;
    return table.foreignKeys.some((fk) => fk.name.toLowerCase().includes(q) || fk.column.toLowerCase().includes(q) || fk.ref_table.toLowerCase().includes(q) || fk.ref_column.toLowerCase().includes(q) || (fk.ref_schema && fk.ref_schema.toLowerCase().includes(q)));
  });
}

export function layoutDiagramTables(tables: (Pick<DiagramTable, "name" | "columns"> & { schema?: string })[], options: DiagramLayoutOptions = {}, isMultiSchema = false): Record<string, DiagramPosition> {
  const columnsPerRow = Math.max(1, options.columnsPerRow ?? Math.ceil(Math.sqrt(Math.max(tables.length, 1))));
  const cardWidth = options.cardWidth ?? 260;
  const gapX = options.gapX ?? 56;
  const gapY = options.gapY ?? 40;
  const margin = options.margin ?? 40;
  const fixedRowHeight = options.rowHeight;

  const measureHeight = (table: Pick<DiagramTable, "columns">): number => {
    if (fixedRowHeight != null) return fixedRowHeight;
    const columnCount = table.columns?.length ?? 0;
    return 44 + columnCount * 24 + 12;
  };

  const positions: Record<string, DiagramPosition> = {};
  let y = margin;
  for (let start = 0; start < tables.length; start += columnsPerRow) {
    const rowTables = tables.slice(start, start + columnsPerRow);
    const rowContentHeight = Math.max(...rowTables.map(measureHeight));
    rowTables.forEach((table, col) => {
      const pos = {
        x: margin + col * (cardWidth + gapX),
        y,
      };
      positions[table.name] = pos;
      if (isMultiSchema && table.schema) {
        positions[`${table.schema}.${table.name}`] = pos;
      }
    });
    y += rowContentHeight + gapY;
  }

  return positions;
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
