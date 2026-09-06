import type { ColumnInfo, DatabaseType, ForeignKeyInfo, IndexInfo, TriggerInfo } from "@/types/database.ts";

export interface ColumnIdentity {
  generation?: "BY DEFAULT" | "ALWAYS";
  seed?: number;
  increment?: number;
}

export interface ColumnExtra {
  autoIncrement?: boolean;
  onUpdateCurrentTimestamp?: boolean;
  identity?: ColumnIdentity;
  manticoreIndexed?: boolean;
  manticoreStored?: boolean;
  manticoreAttribute?: boolean;
  manticoreSecondaryIndex?: boolean;
}

export interface EditableStructureColumn {
  id: string;
  name: string;
  dataType: string;
  enumValues?: string[];
  isNullable: boolean;
  defaultValue: string;
  comment: string;
  isPrimaryKey: boolean;
  extra: ColumnExtra;
  characterSet?: string;
  collation?: string;
  original?: ColumnInfo;
  originalPosition?: number;
  markedForDrop: boolean;
}

export interface EditableStructureIndex {
  id: string;
  name: string;
  columns: string[];
  nameEdited?: boolean;
  isUnique: boolean;
  isPrimary: boolean;
  filter: string;
  indexType: string;
  includedColumns: string[];
  comment: string;
  /** Build the index with PostgreSQL `CREATE INDEX CONCURRENTLY` (PostgreSQL only, default off). */
  concurrently?: boolean;
  /** Parallel to `columns`: operator class for each key column (PostgreSQL). `null` means default. */
  columnOpclasses?: (string | null)[];
  original?: IndexInfo;
  markedForDrop: boolean;
}

export interface EditableStructureForeignKey {
  id: string;
  name: string;
  column: string;
  refSchema: string;
  refTable: string;
  refColumn: string;
  onUpdate: string;
  onDelete: string;
  original?: ForeignKeyInfo;
  markedForDrop: boolean;
}

export interface EditableStructureTrigger {
  id: string;
  name: string;
  timing: string;
  event: string;
  statement: string;
  original?: TriggerInfo;
  markedForDrop: boolean;
}

export interface BuildTableStructureChangeSqlOptions {
  databaseType?: DatabaseType;
  /** Driver profile reported by the connection (e.g. `"gbase8s"`). GBase 8s is
   * Informix-compatible rather than MySQL-compatible like the rest of the
   * `Gbase` family, so this disambiguates which dialect the backend generates. */
  driverProfile?: string | null;
  schema?: string;
  tableName: string;
  columns: EditableStructureColumn[];
  indexes: EditableStructureIndex[];
  foreignKeys?: EditableStructureForeignKey[];
  triggers?: EditableStructureTrigger[];
  tableComment?: string;
  originalTableComment?: string;
  mysqlEngine?: string;
  /** MySQL only: the table's current default collation. Columns whose collation merely
   * matches it inherit the table default, so the backend leaves their redundant
   * `CHARACTER SET`/`COLLATE` clauses out of the generated DDL. */
  tableCollation?: string;
  /** The target table is a PostgreSQL partitioned parent (`relkind = 'p'`);
   * the backend rejects `CREATE INDEX CONCURRENTLY` on such tables (fail
   * closed) instead of downgrading to a blocking `CREATE INDEX`. */
  partitioned?: boolean;
  /** When true, the connection is GaussDB M-mode which uses MySQL-compatible
   * SQL dialect with backtick quoting. */
  isGaussdbMMode?: boolean;
}

export interface TableStructureChangeSql {
  statements: string[];
  warnings: string[];
}

export interface BuildTableOwnerChangeSqlOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName: string;
  owner: string;
  originalOwner: string;
}

export interface SqliteTableStructureChangePreview extends TableStructureChangeSql {
  schemaRevision: string;
}

export interface BuildSingleColumnAlterSqlOptions {
  databaseType?: DatabaseType;
  driverProfile?: string | null;
  schema?: string;
  tableName: string;
  column: EditableStructureColumn;
}
