export type SchemaDiffTableFilterPriority = "include" | "exclude";

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
  compareColumnOrder: boolean;
  tableIncludePattern: string;
  tableExcludePattern: string;
  tableFilterPriority: SchemaDiffTableFilterPriority;
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
  id: BooleanSchemaDiffCompareOptionKey;
  labelKey: string;
  defaultChecked: boolean;
  children?: SchemaDiffOptionItem[];
}

export type BooleanSchemaDiffCompareOptionKey = {
  [K in keyof SchemaDiffCompareOptions]: SchemaDiffCompareOptions[K] extends boolean ? K : never;
}[keyof SchemaDiffCompareOptions];

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
  compareColumnOrder: false,
  tableIncludePattern: "",
  tableExcludePattern: "",
  tableFilterPriority: "exclude",
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
  compareColumnOrder: false,
  tableIncludePattern: "",
  tableExcludePattern: "",
  tableFilterPriority: "exclude",
};

export function getDefaultOptionsForDbType(dbType: string): SchemaDiffCompareOptions {
  if (dbType === "postgres" || dbType === "opengauss") {
    return { ...DEFAULT_POSTGRES_OPTIONS };
  }
  return { ...DEFAULT_MYSQL_OPTIONS };
}

export function normalizeSchemaDiffCompareOptions(options: Partial<SchemaDiffCompareOptions> | null | undefined, dbType = "postgres"): SchemaDiffCompareOptions {
  return {
    ...getDefaultOptionsForDbType(dbType),
    ...options,
  };
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
