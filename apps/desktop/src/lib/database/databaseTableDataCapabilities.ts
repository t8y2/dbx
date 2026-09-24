import type { DatabaseType } from "@/types/database";
import { isSchemaAware, usesTreeSchemaMode } from "@/lib/database/databaseFeatureSupport";

export type SyntheticEditKey = "oracle-rowid" | "xugu-rowid" | "neo4j-element-id";

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
  "cloudflare-d1",
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
  "uxdb",
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
  "spanner",
  "sundb",
  "oscar",
  "databend",
]);

const DATABASE_CAPABILITY_OVERRIDES: Partial<Record<DatabaseType, Partial<DatabaseCapability>>> = {
  kyuubi: {
    tableData: {
      insert: false,
      updateRequiresPrimaryKey: false,
      deleteRequiresPrimaryKey: false,
      requiresTransactionalTableForExistingRows: false,
      existingRowsReadonly: true,
      transaction: false,
      readonly: true,
    },
  },
  impala: {
    tableData: {
      insert: false,
      updateRequiresPrimaryKey: false,
      deleteRequiresPrimaryKey: false,
      requiresTransactionalTableForExistingRows: false,
      existingRowsReadonly: true,
      transaction: false,
      readonly: true,
    },
  },
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
  argo: {
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
  xugu: {
    // Xugu exposes a stable ROWID pseudo-column for base, partitioned and
    // temporary tables. Keep this capability scoped to Xugu instead of
    // broadening Oracle-compatible behavior for other drivers.
    syntheticKey: "xugu-rowid",
    tableData: {
      insert: true,
      updateRequiresPrimaryKey: false,
      deleteRequiresPrimaryKey: false,
      keylessRowPredicate: true,
      requiresTransactionalTableForExistingRows: false,
      transaction: true,
    },
  },
  "oceanbase-oracle": {
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
  prestosql: {
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
      insert: true,
      updateRequiresPrimaryKey: true,
      deleteRequiresPrimaryKey: true,
      requiresTransactionalTableForExistingRows: false,
      transaction: false,
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
  victoriametrics: {
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
  salesforce: {
    // SOQL has no DML. A grid save becomes one `DBX SALESFORCE DML` pseudo-command
    // per record (built by dbx-sql) which the driver turns into a REST call:
    // PATCH /sobjects/{object}/{id}, POST /sobjects/{object}, DELETE /sobjects/{object}/{id}.
    // Row identity is the `Id` column (the driver marks it is_primary_key), so both
    // update and delete require it. REST has no transactions: records are written
    // one by one, a failure leaves the earlier records applied, and nothing can be
    // rolled back — the grid therefore asks for confirmation before saving.
    tableData: {
      insert: true,
      updateRequiresPrimaryKey: true,
      deleteRequiresPrimaryKey: true,
      keylessRowPredicate: false,
      requiresTransactionalTableForExistingRows: false,
      existingRowsReadonly: false,
      transaction: false,
      readonly: false,
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
