import type { DatabaseType } from "@/types/database";

export interface TableMetadataCapabilities {
  columns: boolean;
  indexes: boolean;
  foreignKeys: boolean;
  triggers: boolean;
  ddl: boolean;
}

const defaultCapabilities: TableMetadataCapabilities = {
  columns: true,
  indexes: true,
  foreignKeys: true,
  triggers: true,
  ddl: true,
};

const capabilityByType: Partial<Record<DatabaseType, Partial<TableMetadataCapabilities>>> = {
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
  questdb: {
    indexes: true,
    foreignKeys: false,
    triggers: false,
  },
};

export function getTableMetadataCapabilities(dbType?: DatabaseType): TableMetadataCapabilities {
  return { ...defaultCapabilities, ...(dbType ? capabilityByType[dbType] : undefined) };
}
