import { isInternalDorisCatalog } from "@/lib/database/databaseFeatureSupport";
import { decodeSelectableDatabaseValue, encodeSelectableDatabaseValue } from "@/lib/database/defaultDatabase";
import type { CatalogInfo, DatabaseType } from "@/types/database";

export interface TransferDatabaseSelection {
  connectionId: string;
  catalog: string;
  catalogs: readonly CatalogInfo[];
  database: string;
}

export function encodeTransferDatabaseOptions(databaseType: DatabaseType | undefined, databases: readonly string[]): string[] {
  return databases.map((database) => encodeSelectableDatabaseValue(databaseType, database));
}

export function decodeTransferDatabaseOption(databaseType: DatabaseType | undefined, option: string): string {
  return decodeSelectableDatabaseValue(databaseType, option);
}

export function isTransferDatabaseSelected(option: string): boolean {
  return option.length > 0;
}

export function normalizeTransferCatalog(catalog: string, catalogs: readonly CatalogInfo[]): string {
  const normalizedCatalog = catalog.trim();
  if (!normalizedCatalog) return "";
  const catalogInfo = catalogs.find((item) => item.name.trim() === normalizedCatalog);
  return isInternalDorisCatalog(catalogInfo?.catalog_type, normalizedCatalog) ? "" : normalizedCatalog;
}

export function isSameTransferDatabase(source: TransferDatabaseSelection, target: TransferDatabaseSelection): boolean {
  return source.connectionId === target.connectionId && source.database === target.database && normalizeTransferCatalog(source.catalog, source.catalogs) === normalizeTransferCatalog(target.catalog, target.catalogs);
}
