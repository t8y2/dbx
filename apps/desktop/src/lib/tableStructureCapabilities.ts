import type { DatabaseType } from "@/types/database";

export type TableStructureDialect = "mysql" | "postgres" | "sqlite" | "duckdb" | "sqlserver" | "oracle" | "h2" | "clickhouse" | "informix" | "influxdb" | "unsupported";

export interface TableStructureCapabilities {
  dialect: TableStructureDialect;
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
}

const unsupportedCapabilities: TableStructureCapabilities = {
  dialect: "unsupported",
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
};

function capabilities(overrides: Partial<TableStructureCapabilities>): TableStructureCapabilities {
  return { ...unsupportedCapabilities, ...overrides };
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
});

const gbaseCapabilities = capabilities({
  dialect: "mysql",
  createTable: true,
  addColumn: true,
  dropColumn: true,
  renameColumn: true,
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
});

const capabilityByType: Partial<Record<DatabaseType, TableStructureCapabilities>> = {
  mysql: mysqlCapabilities,
  doris: mysqlCapabilities,
  starrocks: mysqlCapabilities,
  goldendb: mysqlCapabilities,
  sundb: mysqlCapabilities,
  databend: mysqlCapabilities,
  gbase: gbaseCapabilities,
  postgres: postgresCapabilities,
  gaussdb: postgresCapabilities,
  kwdb: postgresCapabilities,
  opengauss: postgresCapabilities,
  questdb: questdbCapabilities,
  redshift: redshiftCapabilities,
  vertica: redshiftCapabilities,
  highgo: postgresCapabilities,
  vastbase: postgresCapabilities,
  kingbase: postgresCapabilities,
  firebird: postgresCapabilities,
  sqlite: sqliteCapabilities,
  rqlite: sqliteCapabilities,
  turso: sqliteCapabilities,
  duckdb: duckdbCapabilities,
  sqlserver: sqlserverCapabilities,
  oracle: oracleCapabilities,
  dameng: oracleCapabilities,
  "oceanbase-oracle": oracleCapabilities,
  iris: oracleCapabilities,
  yashandb: oracleCapabilities,
  xugu: oracleCapabilities,
  h2: h2Capabilities,
  access: accessCapabilities,
  clickhouse: clickhouseCapabilities,
  informix: informixCapabilities,
  influxdb: influxdbCapabilities,
  manticoresearch: manticoreSearchCapabilities,
};

export function getTableStructureCapabilities(dbType?: DatabaseType): TableStructureCapabilities {
  return dbType ? (capabilityByType[dbType] ?? unsupportedCapabilities) : unsupportedCapabilities;
}

export function canEditTableStructure(dbType?: DatabaseType): boolean {
  const caps = getTableStructureCapabilities(dbType);
  return caps.createTable || caps.addColumn || caps.alterExistingColumn || caps.createIndex || caps.dropIndex;
}

export function canAddTableStructureColumn(dbType: DatabaseType | undefined, isCreateMode: boolean): boolean {
  const caps = getTableStructureCapabilities(dbType);
  return isCreateMode ? caps.createTable : caps.addColumn;
}
