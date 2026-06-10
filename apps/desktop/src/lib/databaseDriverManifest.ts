import type { DatabaseType } from "@/types/database";
import driverManifest from "../../../../crates/dbx-core/assets/database-drivers.manifest.json";

export type DatabaseSupportLevel = "connect" | "browse" | "understand" | "operate";

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

interface DatabaseDriverManifestEntry {
  dbType: DatabaseType;
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

function productCapabilities(overrides: Partial<DatabaseProductCapabilities>): DatabaseProductCapabilities {
  const capabilities = Object.fromEntries(DATABASE_PRODUCT_CAPABILITY_KEYS.map((key) => [key, false])) as DatabaseProductCapabilities;
  return { ...capabilities, ...overrides };
}
