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
  influxdb: {
    indexes: false,
    foreignKeys: false,
    triggers: false,
  },
};

export function getTableMetadataCapabilities(dbType?: DatabaseType): TableMetadataCapabilities {
  return { ...defaultCapabilities, ...(dbType ? capabilityByType[dbType] : undefined) };
}