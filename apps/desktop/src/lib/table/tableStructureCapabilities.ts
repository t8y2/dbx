import type { DatabaseType } from "@/types/database";
import type { EditableStructureIndex } from "@/lib/table/tableStructureEditorSql";

export type TableStructureDialect = "mysql" | "postgres" | "sqlite" | "duckdb" | "sqlserver" | "oracle" | "h2" | "clickhouse" | "informix" | "influxdb" | "unsupported";
export type TableStructureAlterStrategy = "none" | "direct" | "sqlite-rebuild";

export interface TableStructureCapabilities {
  dialect: TableStructureDialect;
  alterStrategy: TableStructureAlterStrategy;
  createTable: boolean;
  addColumn: boolean;
  dropColumn: boolean;
  renameColumn: boolean;
  alterExistingColumn: boolean;
  alterType: boolean;
  alterNullability: boolean;
  alterDefault: boolean;
  alterPrimaryKey: boolean;
  reorderColumn: boolean;
  comment: boolean;
  createIndex: boolean;
  dropIndex: boolean;
  rebuildIndex: boolean;
  indexType: boolean;
  indexInclude: boolean;
  indexFilter: boolean;
  indexComment: boolean;
  indexConcurrent: boolean;
  foreignKey: boolean;
}

const unsupportedCapabilities: TableStructureCapabilities = {
  dialect: "unsupported",
  alterStrategy: "none",
  createTable: false,
  addColumn: false,
  dropColumn: false,
  renameColumn: false,
  alterExistingColumn: false,
  alterType: false,
  alterNullability: false,
  alterDefault: false,
  alterPrimaryKey: false,
  reorderColumn: false,
  comment: false,
  createIndex: false,
  dropIndex: false,
  rebuildIndex: false,
  indexType: false,
  indexInclude: false,
  indexFilter: false,
  indexComment: false,
  indexConcurrent: false,
  foreignKey: false,
};

function capabilities(overrides: Partial<TableStructureCapabilities>): TableStructureCapabilities {
  const resolved = { ...unsupportedCapabilities, ...overrides };
  if (overrides.alterStrategy === undefined && resolved.alterExistingColumn) {
    resolved.alterStrategy = "direct";
  }
  return resolved;
}

const mysqlCapabilities = capabilities({
  dialect: "mysql",
  createTable: true,
  addColumn: true,
  dropColumn: true,
  renameColumn: true,
  alterExistingColumn: true,
  alterType: true,
  alterNullability: true,
  alterDefault: true,
  reorderColumn: true,
  comment: true,
  createIndex: true,
  dropIndex: true,
  rebuildIndex: true,
  indexType: true,
  indexComment: true,
  alterPrimaryKey: true,
  foreignKey: true,
});

const gbaseCapabilities = capabilities({
  dialect: "mysql",
  createTable: true,
  addColumn: true,
  dropColumn: true,
  renameColumn: true,
  reorderColumn: true,
});

const postgresCapabilities = capabilities({
  dialect: "postgres",
  createTable: true,
  addColumn: true,
  dropColumn: true,
  renameColumn: true,
  alterExistingColumn: true,
  alterType: true,
  alterNullability: true,
  alterDefault: true,
  comment: true,
  createIndex: true,
  dropIndex: true,
  rebuildIndex: true,
  indexType: true,
  indexInclude: true,
  indexFilter: true,
  indexComment: true,
  alterPrimaryKey: true,
  foreignKey: true,
});

const postgresBefore11Capabilities = capabilities({
  ...postgresCapabilities,
  indexInclude: false,
  indexConcurrent: true,
});

const redshiftCapabilities = capabilities({
  ...postgresCapabilities,
  createIndex: false,
  dropIndex: false,
  rebuildIndex: false,
  indexType: false,
  indexInclude: false,
  indexFilter: false,
  indexComment: false,
  alterPrimaryKey: false,
});

const sqliteCapabilities = capabilities({
  dialect: "sqlite",
  createTable: true,
  addColumn: true,
  dropColumn: true,
  renameColumn: true,
  createIndex: true,
  dropIndex: true,
  rebuildIndex: true,
  indexFilter: true,
});

const nativeSqliteCapabilities = capabilities({
  ...sqliteCapabilities,
  alterStrategy: "sqlite-rebuild",
  alterExistingColumn: true,
  alterType: true,
});

const duckdbCapabilities = capabilities({
  dialect: "duckdb",
  createTable: true,
  addColumn: true,
  dropColumn: true,
  renameColumn: true,
  createIndex: true,
  dropIndex: true,
  rebuildIndex: true,
});

const sqlserverCapabilities = capabilities({
  dialect: "sqlserver",
  createTable: true,
  addColumn: true,
  dropColumn: true,
  renameColumn: true,
  alterExistingColumn: true,
  alterType: true,
  alterNullability: true,
  alterDefault: true,
  comment: true,
  createIndex: true,
  dropIndex: true,
  rebuildIndex: true,
  indexType: true,
  indexInclude: true,
  indexFilter: true,
  indexComment: true,
});

const oracleCapabilities = capabilities({
  dialect: "oracle",
  createTable: true,
  addColumn: true,
  dropColumn: true,
  renameColumn: true,
  alterExistingColumn: true,
  alterType: true,
  alterNullability: true,
  alterDefault: true,
  comment: true,
  createIndex: true,
  dropIndex: true,
  rebuildIndex: true,
  indexType: true,
});

// Dameng (DM8): ALTER TABLE ... DROP PRIMARY KEY / ADD PRIMARY KEY is official DDL.
// Keep separate from oracleCapabilities so UI cannot enable PK edit without BE drop SQL.
const damengCapabilities = capabilities({
  ...oracleCapabilities,
  alterPrimaryKey: true,
});

const irisCapabilities = capabilities({
  ...oracleCapabilities,
  // IRIS exposes %DESCRIPTION at definition time but cannot alter persisted descriptions.
  comment: false,
});

const h2Capabilities = capabilities({
  dialect: "h2",
  createTable: true,
  addColumn: true,
  dropColumn: true,
  renameColumn: true,
  alterExistingColumn: true,
  alterType: true,
  alterNullability: true,
  alterDefault: true,
  comment: true,
  createIndex: true,
  dropIndex: true,
  rebuildIndex: true,
});

const clickhouseCapabilities = capabilities({
  dialect: "clickhouse",
  createTable: true,
  addColumn: true,
  dropColumn: true,
  renameColumn: true,
  alterExistingColumn: true,
  alterType: true,
  alterNullability: true,
  alterDefault: true,
  reorderColumn: true,
  comment: true,
});

const informixCapabilities = capabilities({
  dialect: "informix",
  createTable: true,
  addColumn: true,
  dropColumn: true,
  renameColumn: true,
  alterExistingColumn: true,
  alterType: true,
  alterNullability: true,
  alterDefault: true,
  createIndex: true,
  dropIndex: true,
  rebuildIndex: true,
});

const accessCapabilities = capabilities({
  dialect: "h2",
  createTable: true,
  addColumn: true,
  createIndex: true,
});

const influxdbCapabilities = capabilities({
  dialect: "influxdb",
  createTable: false,
  addColumn: false,
  dropColumn: false,
  renameColumn: false,
  alterExistingColumn: false,
  alterType: false,
  alterNullability: false,
  alterDefault: false,
  reorderColumn: false,
  comment: false,
});

const manticoreSearchCapabilities = capabilities({
  dialect: "mysql",
  createTable: true,
  addColumn: true,
  dropColumn: true,
});

const questdbCapabilities = capabilities({
  dialect: "postgres",
  createTable: true,
  addColumn: true,
  dropColumn: true,
  renameColumn: true,
  alterExistingColumn: true,
  alterType: true,
  alterNullability: false,
  alterDefault: false,
  comment: false,
  createIndex: false,
  dropIndex: false,
  rebuildIndex: false,
  indexType: false,
  indexInclude: false,
  indexFilter: false,
  indexComment: false,
  alterPrimaryKey: false,
  foreignKey: false,
});

const firebirdCapabilities = capabilities({
  ...postgresCapabilities,
  foreignKey: false,
});

const capabilityByType: Partial<Record<DatabaseType, TableStructureCapabilities>> = {
  mysql: mysqlCapabilities,
  doris: mysqlCapabilities,
  starrocks: mysqlCapabilities,
  goldendb: mysqlCapabilities,
  sundb: mysqlCapabilities,
  oscar: damengCapabilities,
  databend: mysqlCapabilities,
  gbase: gbaseCapabilities,
  postgres: capabilities({ ...postgresCapabilities, indexConcurrent: true }),
  gaussdb: postgresCapabilities,
  kwdb: postgresCapabilities,
  opengauss: postgresCapabilities,
  questdb: questdbCapabilities,
  redshift: redshiftCapabilities,
  vertica: redshiftCapabilities,
  highgo: postgresCapabilities,
  uxdb: postgresCapabilities,
  vastbase: postgresCapabilities,
  kingbase: postgresCapabilities,
  firebird: firebirdCapabilities,
  sqlite: sqliteCapabilities,
  rqlite: sqliteCapabilities,
  turso: sqliteCapabilities,
  duckdb: duckdbCapabilities,
  sqlserver: sqlserverCapabilities,
  oracle: oracleCapabilities,
  dameng: damengCapabilities,
  "oceanbase-oracle": oracleCapabilities,
  iris: irisCapabilities,
  yashandb: oracleCapabilities,
  xugu: oracleCapabilities,
  h2: h2Capabilities,
  access: accessCapabilities,
  clickhouse: clickhouseCapabilities,
  informix: informixCapabilities,
  influxdb: influxdbCapabilities,
  manticoresearch: manticoreSearchCapabilities,
};

function postgresMajorVersion(productVersion?: string): number | undefined {
  const normalized = productVersion?.trim();
  if (!normalized) return undefined;
  const match = normalized.match(/\bPostgreSQL\s+(\d+)(?:\.\d+)?\b/i) ?? normalized.match(/^(\d+)(?:\.\d+)?\b/);
  if (!match) return undefined;
  const majorVersion = Number.parseInt(match[1], 10);
  return Number.isFinite(majorVersion) ? majorVersion : undefined;
}

export function getTableStructureCapabilities(dbType?: DatabaseType, connectionDbType?: DatabaseType, productVersion?: string): TableStructureCapabilities {
  if (dbType === "sqlite" && connectionDbType === "sqlite") return nativeSqliteCapabilities;
  if (dbType === "postgres") {
    const majorVersion = postgresMajorVersion(productVersion);
    if (majorVersion !== undefined && majorVersion < 11) return postgresBefore11Capabilities;
  }
  return dbType ? (capabilityByType[dbType] ?? unsupportedCapabilities) : unsupportedCapabilities;
}

export function sanitizeStructureIndexesForCapabilities(indexes: EditableStructureIndex[], capabilities: Pick<TableStructureCapabilities, "indexInclude">): EditableStructureIndex[] {
  if (capabilities.indexInclude || indexes.every((index) => index.includedColumns.length === 0)) return indexes;
  return indexes.map((index) => (index.includedColumns.length === 0 ? index : { ...index, includedColumns: [] }));
}

export function canEditTableStructure(dbType?: DatabaseType): boolean {
  const caps = getTableStructureCapabilities(dbType);
  return caps.createTable || caps.addColumn || caps.alterExistingColumn || caps.createIndex || caps.dropIndex;
}

export function supportsLocalTableColumnReorder(dbType?: DatabaseType, connectionDbType?: DatabaseType): boolean {
  const caps = getTableStructureCapabilities(dbType, connectionDbType);
  return canEditTableStructure(dbType) && !caps.reorderColumn;
}

export function isPhysicalTableColumnOrderChange(dbType: DatabaseType | undefined, connectionDbType: DatabaseType | undefined, originalPosition: number | undefined, currentPosition: number): boolean {
  return getTableStructureCapabilities(dbType, connectionDbType).reorderColumn && originalPosition !== currentPosition;
}

export function hasLocalTableColumnOrderChange(columns: readonly { originalPosition?: number; original?: unknown; markedForDrop?: boolean }[]): boolean {
  const activeColumns = columns.filter((column) => !column.markedForDrop);
  // Databases without physical reorder support keep existing columns in ordinal order
  // and append newly added columns, so compare against that post-save layout.
  const databaseOrder = [...activeColumns.filter((column) => column.original).sort((left, right) => (left.originalPosition ?? Number.MAX_SAFE_INTEGER) - (right.originalPosition ?? Number.MAX_SAFE_INTEGER)), ...activeColumns.filter((column) => !column.original)];
  return activeColumns.some((column, index) => column !== databaseOrder[index]);
}

export function canAddTableStructureColumn(dbType: DatabaseType | undefined, isCreateMode: boolean): boolean {
  const caps = getTableStructureCapabilities(dbType);
  return isCreateMode ? caps.createTable : caps.addColumn;
}
