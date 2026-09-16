import type { DatabaseType } from "@/types/database";
import driverManifest from "../../../../../crates/dbx-core/assets/database-drivers.manifest.json";

export type DatabaseSupportLevel = "connect" | "browse" | "understand" | "operate";
export type DatabaseRuntimeMode = "native" | "file" | "agent" | "external";
export type ConnectionFormKind = "standard" | "jdbc" | "mq" | "mqtt" | "nacos";

export const DATABASE_PRODUCT_CAPABILITY_KEYS = [
  "queryExecution",
  "metadataBrowse",
  "objectBrowser",
  "objectSource",
  "schemaSearch",
  "diagram",
  "tableDataEdit",
  "tableStructureEdit",
  "tableImport",
  "dataTransfer",
  "sqlFileExecution",
  "databaseCreate",
  "fieldLineage",
  "sqlExplain",
  "userAdmin",
  "driverManagement",
] as const;

export type DatabaseProductCapability = (typeof DATABASE_PRODUCT_CAPABILITY_KEYS)[number];
export type DatabaseProductCapabilities = Record<DatabaseProductCapability, boolean>;

export const DATABASE_BEHAVIOR_TRAIT_KEYS = ["schemaAware", "databaseSchemaQualified", "singleDatabase", "clearableQuerySchema", "fetchFirst", "treeSchema", "databaseObjectTree", "pgVacuum", "pgLikeStructure", "diagramSql"] as const;

export type DatabaseBehaviorTrait = (typeof DATABASE_BEHAVIOR_TRAIT_KEYS)[number];
export type DatabaseBehaviorTraits = Partial<Record<DatabaseBehaviorTrait, boolean>>;

export interface DatabaseDriverProfile {
  profile: string;
  agentKey: string;
  packageKey?: string;
  label: string;
  storeVisible: boolean;
  storeOrder?: number;
}

export interface ManagedDatabaseDriver {
  key: string;
  label: string;
  storeVisible: boolean;
  storeOrder?: number;
}

export interface DatabaseDriverManifestEntry {
  dbType: DatabaseType;
  label: string;
  dialect?: string;
  runtimeMode: DatabaseRuntimeMode;
  mcpMode: "direct" | "bridge" | "unsupported";
  agentKey?: string;
  driverStoreVisible?: boolean;
  driverStoreOrder?: number;
  driverProfiles?: DatabaseDriverProfile[];
  managedDrivers?: ManagedDatabaseDriver[];
  singleConnectionPool: boolean;
  metadataConnectionScoped: boolean;
  skipTcpProbe: boolean;
  defaultPort?: number;
  localFile?: boolean;
  specializedSurface?: boolean;
  formKind?: ConnectionFormKind;
  traits?: DatabaseBehaviorTraits;
  supportLevel: DatabaseSupportLevel;
  capabilities: Partial<DatabaseProductCapabilities>;
}

const SUPPORT_LEVEL_DEFAULTS: Record<DatabaseSupportLevel, DatabaseProductCapabilities> = {
  connect: productCapabilities({
    queryExecution: true,
    sqlFileExecution: true,
  }),
  browse: productCapabilities({
    metadataBrowse: true,
    objectBrowser: true,
    sqlFileExecution: true,
  }),
  understand: productCapabilities({
    metadataBrowse: true,
    objectBrowser: true,
    schemaSearch: true,
    sqlFileExecution: true,
  }),
  operate: productCapabilities({
    metadataBrowse: true,
    objectBrowser: true,
    schemaSearch: true,
    tableDataEdit: true,
    sqlFileExecution: true,
  }),
};

const DEFAULT_CAPABILITIES = productCapabilities({});

const DATABASE_DRIVER_ENTRIES = (driverManifest.drivers as DatabaseDriverManifestEntry[]).map((entry) => ({
  ...entry,
  capabilities: {
    ...SUPPORT_LEVEL_DEFAULTS[entry.supportLevel],
    ...entry.capabilities,
  },
}));

const DATABASE_DRIVER_BY_TYPE = new Map<DatabaseType, DatabaseDriverManifestEntry>(DATABASE_DRIVER_ENTRIES.map((entry) => [entry.dbType, entry]));

export function databaseSupportLevel(dbType?: DatabaseType): DatabaseSupportLevel | undefined {
  return dbType ? DATABASE_DRIVER_BY_TYPE.get(dbType)?.supportLevel : undefined;
}

export function databaseManifestEntry(dbType?: DatabaseType): DatabaseDriverManifestEntry | undefined {
  return dbType ? DATABASE_DRIVER_BY_TYPE.get(dbType) : undefined;
}

export function databaseDefaultPort(dbType?: DatabaseType): number | undefined {
  return databaseManifestEntry(dbType)?.defaultPort;
}

export function databaseConnectionFormKind(dbType?: DatabaseType): ConnectionFormKind {
  return databaseManifestEntry(dbType)?.formKind ?? "standard";
}

export function isKnownDatabaseType(value: string): value is DatabaseType {
  return DATABASE_DRIVER_BY_TYPE.has(value as DatabaseType);
}

export function isLocalFileDatabaseType(dbType?: DatabaseType): boolean {
  return databaseManifestEntry(dbType)?.localFile === true;
}

export function databaseTypesWithTrait(trait: DatabaseBehaviorTrait): Set<DatabaseType> {
  return new Set(DATABASE_DRIVER_ENTRIES.filter((entry) => entry.traits?.[trait] === true).map((entry) => entry.dbType));
}

export function databaseRuntimeMode(dbType?: DatabaseType): DatabaseRuntimeMode | undefined {
  return dbType ? DATABASE_DRIVER_BY_TYPE.get(dbType)?.runtimeMode : undefined;
}

export function databaseProductCapabilities(dbType?: DatabaseType): DatabaseProductCapabilities {
  if (!dbType) return DEFAULT_CAPABILITIES;
  return (DATABASE_DRIVER_BY_TYPE.get(dbType)?.capabilities ?? DEFAULT_CAPABILITIES) as DatabaseProductCapabilities;
}

export function supportsDatabaseFeature(dbType: DatabaseType | undefined, capability: DatabaseProductCapability): boolean {
  return databaseProductCapabilities(dbType)[capability];
}

export function manifestDatabaseTypes(): DatabaseType[] {
  return DATABASE_DRIVER_ENTRIES.map((entry) => entry.dbType);
}

export function usesAgentCursorForQuery(dbType?: DatabaseType, driverProfile?: string): boolean {
  if (dbType === "sqlserver" && driverProfile?.trim().toLowerCase() === "sqlserver-legacy") return true;
  const runtimeMode = databaseRuntimeMode(dbType);
  return runtimeMode === "agent" || runtimeMode === "external";
}

function productCapabilities(overrides: Partial<DatabaseProductCapabilities>): DatabaseProductCapabilities {
  const capabilities = Object.fromEntries(DATABASE_PRODUCT_CAPABILITY_KEYS.map((key) => [key, false])) as DatabaseProductCapabilities;
  return { ...capabilities, ...overrides };
}
