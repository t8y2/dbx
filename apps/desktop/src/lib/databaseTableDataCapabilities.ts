import type { DatabaseType } from "@/types/database";
import { isSchemaAware, usesTreeSchemaMode } from "./databaseFeatureSupport";

export type SyntheticEditKey = "oracle-rowid" | "neo4j-element-id";

export interface TableDataCapability {
  insert: boolean;
  updateRequiresPrimaryKey: boolean;
  deleteRequiresPrimaryKey: boolean;
  keylessRowPredicate?: boolean;
  requiresTransactionalTableForExistingRows: boolean;
  existingRowsReadonly?: boolean;
  transaction: boolean;
  readonly?: boolean;
}

export interface DatabaseCapability {
  schemaAware: boolean;
  treeSchemaMode: boolean;
  tableData: TableDataCapability;
  syntheticKey?: SyntheticEditKey;
}

const DEFAULT_TABLE_DATA_CAPABILITY: TableDataCapability = {
  insert: false,
  updateRequiresPrimaryKey: true,
  deleteRequiresPrimaryKey: true,
  keylessRowPredicate: false,
  requiresTransactionalTableForExistingRows: false,
  transaction: true,
};

const NAVICAT_STYLE_TABLE_DATA_CAPABILITY: TableDataCapability = {
  insert: true,
  updateRequiresPrimaryKey: false,
  deleteRequiresPrimaryKey: false,
  keylessRowPredicate: true,
  requiresTransactionalTableForExistingRows: false,
  transaction: true,
};

const DEFAULT_CAPABILITY: DatabaseCapability = {
  schemaAware: false,
  treeSchemaMode: false,
  tableData: DEFAULT_TABLE_DATA_CAPABILITY,
};

const NAVICAT_STYLE_TABLE_DATA_TYPES = new Set<DatabaseType>([
  "mysql",
  "manticoresearch",
  "postgres",
  "sqlite",
  "rqlite",
  "turso",
  "duckdb",
  "sqlserver",
  "oracle",
  "doris",
  "starrocks",
  "redshift",
  "dameng",
  "gaussdb",
  "kwdb",
  "kingbase",
  "highgo",
  "vastbase",
  "goldendb",
  "yashandb",
  "databricks",
  "saphana",
  "teradata",
  "vertica",
  "firebird",
  "exasol",
  "opengauss",
  "questdb",
  "oceanbase-oracle",
  "gbase",
  "access",
  "h2",
  "snowflake",
  "db2",
  "informix",
  "bigquery",
  "sundb",
]);

const DATABASE_CAPABILITY_OVERRIDES: Partial<Record<DatabaseType, Partial<DatabaseCapability>>> = {
  hive: {
    tableData: {
      insert: true,
      updateRequiresPrimaryKey: false,
      deleteRequiresPrimaryKey: false,
      keylessRowPredicate: true,
      requiresTransactionalTableForExistingRows: true,
      transaction: false,
    },
  },
  jdbc: {
    tableData: {
      insert: false,
      updateRequiresPrimaryKey: true,
      deleteRequiresPrimaryKey: true,
      requiresTransactionalTableForExistingRows: false,
      transaction: false,
    },
  },
  manticoresearch: {
    tableData: {
      insert: true,
      updateRequiresPrimaryKey: false,
      deleteRequiresPrimaryKey: false,
      keylessRowPredicate: true,
      requiresTransactionalTableForExistingRows: false,
      transaction: false,
    },
  },
  neo4j: {
    syntheticKey: "neo4j-element-id",
  },
  oracle: {
    syntheticKey: "oracle-rowid",
  },
  trino: {
    tableData: {
      insert: true,
      updateRequiresPrimaryKey: true,
      deleteRequiresPrimaryKey: true,
      requiresTransactionalTableForExistingRows: false,
      transaction: false,
    },
  },
  clickhouse: {
    tableData: {
      insert: false,
      updateRequiresPrimaryKey: true,
      deleteRequiresPrimaryKey: true,
      requiresTransactionalTableForExistingRows: false,
      transaction: false,
      readonly: true,
    },
  },
  tdengine: {
    tableData: {
      insert: true,
      updateRequiresPrimaryKey: true,
      deleteRequiresPrimaryKey: true,
      requiresTransactionalTableForExistingRows: false,
      transaction: false,
    },
  },
  influxdb: {
    tableData: {
      insert: false,
      updateRequiresPrimaryKey: false,
      deleteRequiresPrimaryKey: true,
      keylessRowPredicate: false,
      requiresTransactionalTableForExistingRows: false,
      existingRowsReadonly: true,
      transaction: false,
      readonly: true,
    },
  },
};

function defaultTableDataCapability(dbType?: DatabaseType): TableDataCapability {
  if (dbType && NAVICAT_STYLE_TABLE_DATA_TYPES.has(dbType)) return NAVICAT_STYLE_TABLE_DATA_CAPABILITY;
  return DEFAULT_TABLE_DATA_CAPABILITY;
}

export function getDatabaseCapability(dbType?: DatabaseType): DatabaseCapability {
  const override = dbType ? DATABASE_CAPABILITY_OVERRIDES[dbType] : undefined;
  const tableData = defaultTableDataCapability(dbType);
  return {
    ...DEFAULT_CAPABILITY,
    ...override,
    schemaAware: isSchemaAware(dbType),
    treeSchemaMode: usesTreeSchemaMode(dbType),
    tableData: {
      ...tableData,
      ...override?.tableData,
    },
  };
}
