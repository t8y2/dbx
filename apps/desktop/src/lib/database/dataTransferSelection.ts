import { isInternalDorisCatalog } from "@/lib/database/databaseFeatureSupport";
import type { CatalogInfo } from "@/types/database";

export interface TransferDatabaseSelection {
  connectionId: string;
  catalog: string;
  catalogs: readonly CatalogInfo[];
  database: string;
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
