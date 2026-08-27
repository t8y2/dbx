import type { DatabaseType, TableInfoTab } from "@/types/database";

export interface TableMetadataCapabilities {
  columns: boolean;
  indexes: boolean;
  foreignKeys: boolean;
  constraints: boolean;
  triggers: boolean;
  ddl: boolean;
}

const defaultCapabilities: TableMetadataCapabilities = {
  columns: true,
  indexes: true,
  foreignKeys: true,
  // Structured constraint metadata (list_constraints) is only enabled for
  // drivers that implement it (PostgreSQL natively; Oracle/Xugu via agents);
  // leave it off by default so every other dialect doesn't grow a permanently
  // empty tab.
  constraints: false,
  triggers: true,
  ddl: true,
};

const capabilityByType: Partial<Record<DatabaseType, Partial<TableMetadataCapabilities>>> = {
  oracle: {
    constraints: true,
  },
  kingbase: {
    constraints: true,
  },
  vastbase: {
    constraints: true,
  },
  opengauss: {
    constraints: true,
  },
  // PostgreSQL reports full pg_constraint metadata (PK/FK/UNIQUE/CHECK/
  // EXCLUDE/NOT NULL) through list_constraints.
  postgres: {
    constraints: true,
  },
  mongodb: {
    columns: false,
    foreignKeys: false,
    triggers: false,
    ddl: false,
  },
  clickhouse: {
    foreignKeys: false,
    triggers: false,
  },
  manticoresearch: {
    foreignKeys: false,
    triggers: false,
  },
  elasticsearch: {
    indexes: false,
    foreignKeys: false,
    triggers: false,
    ddl: false,
  },
  easysearch: {
    indexes: false,
    foreignKeys: false,
    triggers: false,
    ddl: false,
  },
  meilisearch: {
    indexes: false,
    foreignKeys: false,
    triggers: false,
    ddl: false,
  },
  hbase: {
    indexes: false,
    foreignKeys: false,
    triggers: false,
    ddl: false,
  },
  qdrant: {
    indexes: false,
    foreignKeys: false,
    triggers: false,
    ddl: false,
  },
  milvus: {
    indexes: false,
    foreignKeys: false,
    triggers: false,
    ddl: false,
  },
  weaviate: {
    indexes: false,
    foreignKeys: false,
    triggers: false,
    ddl: false,
  },
  chromadb: {
    indexes: false,
    foreignKeys: false,
    triggers: false,
    ddl: false,
  },
  influxdb: {
    indexes: false,
    foreignKeys: false,
    triggers: false,
    ddl: false,
  },
  victoriametrics: {
    indexes: false,
    foreignKeys: false,
    triggers: false,
    ddl: false,
  },
  questdb: {
    indexes: true,
    foreignKeys: false,
    triggers: false,
  },
};

export function getTableMetadataCapabilities(dbType?: DatabaseType): TableMetadataCapabilities {
  return { ...defaultCapabilities, ...(dbType ? capabilityByType[dbType] : undefined) };
}

export function firstStructureMetadataTab(capabilities: TableMetadataCapabilities, isCreateMode: boolean): TableInfoTab {
  // Structure editing should open on an editable metadata page; DDL remains a
  // read-only fallback for databases that do not expose editable metadata.
  if (capabilities.columns) return "columns";
  if (capabilities.indexes) return "indexes";
  if (capabilities.foreignKeys) return "foreignKeys";
  if (capabilities.constraints) return "constraints";
  if (capabilities.triggers) return "triggers";
  if (!isCreateMode && capabilities.ddl) return "ddl";
  return "columns";
}

export function isStructureMetadataTabSupported(tab: TableInfoTab, capabilities: TableMetadataCapabilities, isCreateMode: boolean): boolean {
  return (
    (tab === "columns" && capabilities.columns) ||
    (tab === "indexes" && capabilities.indexes) ||
    (tab === "foreignKeys" && capabilities.foreignKeys) ||
    (tab === "constraints" && capabilities.constraints) ||
    (tab === "triggers" && capabilities.triggers) ||
    (tab === "ddl" && capabilities.ddl && !isCreateMode)
  );
}
