import type { ExternalSqlFileStatus, ExternalSqlFileSnapshot } from "@/lib/backend/tauri";
import type { ExternalSqlFileVersion, QueryTab } from "@/types/database";

export function externalSqlFileMetadataMatches(version: ExternalSqlFileVersion | undefined, status: ExternalSqlFileStatus): boolean {
  return !!version && status.kind === "present" && version.sizeBytes === status.sizeBytes && version.modifiedNs === status.modifiedNs;
}

export function externalSqlFileContentMatchesBaseline(tab: QueryTab, snapshot: ExternalSqlFileSnapshot): boolean {
  return tab.externalSqlFileVersion?.contentHash === snapshot.version.contentHash || tab.originalSql === snapshot.content;
}

export function externalSqlFileVersionWasIgnored(tab: QueryTab, snapshot: ExternalSqlFileSnapshot): boolean {
  return tab.externalSqlIgnoredFileVersion?.contentHash === snapshot.version.contentHash;
}
