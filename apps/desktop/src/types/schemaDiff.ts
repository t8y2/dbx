export interface SchemaDiffCompareOptions {
  tables: boolean;
  primaryKeys: boolean;
  foreignKeys: boolean;
  uniqueKeys: boolean;
  checks: boolean;
  exclusions: boolean;
  views: boolean;
  functions: boolean;
  indexes: boolean;
  sequences: boolean;
  triggers: boolean;
  rules: boolean;
  owners: boolean;
  cascadeDelete: boolean;
  sequenceLastValues: boolean;
}

export interface SchemaDiffConfig {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  sourceConnectionId: string;
  sourceDatabase: string;
  sourceSchema: string;
  targetConnectionId: string;
  targetDatabase: string;
  targetSchema: string;
  options: SchemaDiffCompareOptions;
}

export interface SchemaDiffOptionItem {
  id: keyof SchemaDiffCompareOptions;
  labelKey: string;
  defaultChecked: boolean;
  children?: SchemaDiffOptionItem[];
}

export type SchemaDiffOptionsMap = Partial<Record<string, SchemaDiffOptionItem[]>>;

export const DEFAULT_POSTGRES_OPTIONS: SchemaDiffCompareOptions = {
  tables: true,
  primaryKeys: true,
  foreignKeys: true,
  uniqueKeys: true,
  checks: true,
  exclusions: true,
  views: true,
  functions: true,
  indexes: true,
  sequences: true,
  triggers: true,
  rules: true,
  owners: true,
  cascadeDelete: false,
  sequenceLastValues: true,
};

export const DEFAULT_MYSQL_OPTIONS: SchemaDiffCompareOptions = {
  tables: true,
  primaryKeys: true,
  foreignKeys: true,
  uniqueKeys: true,
  checks: true,
  exclusions: false,
  views: true,
  functions: false,
  indexes: true,
  sequences: false,
  triggers: true,
  rules: false,
  owners: false,
  cascadeDelete: false,
  sequenceLastValues: false,
};

export function getDefaultOptionsForDbType(dbType: string): SchemaDiffCompareOptions {
  if (dbType === "postgres" || dbType === "opengauss") {
    return { ...DEFAULT_POSTGRES_OPTIONS };
  }
  return { ...DEFAULT_MYSQL_OPTIONS };
}

export function createEmptyConfig(id: string, name: string): SchemaDiffConfig {
  const now = Date.now();
  return {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    sourceConnectionId: "",
    sourceDatabase: "",
    sourceSchema: "",
    targetConnectionId: "",
    targetDatabase: "",
    targetSchema: "",
    options: { ...DEFAULT_POSTGRES_OPTIONS },
  };
}

export function cloneConfig(config: SchemaDiffConfig, newId: string, newName: string): SchemaDiffConfig {
  const now = Date.now();
  return {
    ...config,
    id: newId,
    name: newName,
    createdAt: now,
    updatedAt: now,
  };
}
