import * as api from "@/lib/backend/api";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { exportSavedSqlFileContent } from "@/lib/savedSql/savedSqlExport";
import { useConnectionStore } from "@/stores/connectionStore";
import type { DatabaseType, ObjectSourceKind } from "@/types/database";

const OBJECT_EXPORT_KINDS = new Set<string>(["PROCEDURE", "FUNCTION", "SEQUENCE", "PACKAGE", "PACKAGE_BODY", "SYNONYM"]);

export function supportsOracleObjectExport(databaseType: DatabaseType | undefined, kind: string): kind is ObjectSourceKind {
  return (databaseType === "oracle" || databaseType === "oceanbase-oracle") && OBJECT_EXPORT_KINDS.has(kind);
}

export async function exportOracleObjectDdl(target: { connectionId: string; database: string; schema: string; name: string; objectType: ObjectSourceKind; signature?: string; catalog?: string }) {
  const store = useConnectionStore();
  const config = store.getConfig(target.connectionId);
  const databaseType = effectiveDatabaseTypeForConnection(config);
  if (!config || !databaseType || !supportsOracleObjectExport(databaseType, target.objectType)) throw new Error("Object export requires Oracle or OceanBase Oracle");
  const fingerprint = connectionConfigFingerprint(config);
  const assertConnection = () => {
    const current = store.getConfig(target.connectionId);
    if (!current || connectionConfigFingerprint(current) !== fingerprint) throw new Error("Connection changed during object export");
  };
  await store.ensureConnected(target.connectionId, { activate: false });
  assertConnection();
  const source = await api.getObjectSource(target.connectionId, target.database, target.schema, target.name, target.objectType, target.signature, undefined, { catalog: target.catalog });
  assertConnection();
  const sql = await api.buildOracleObjectExportSql({ databaseType, schema: target.schema, name: target.name, objectType: target.objectType, source: source.source });
  assertConnection();
  const suffix = target.objectType === "PACKAGE_BODY" ? ".body" : "";
  return exportSavedSqlFileContent(`${sql}\n`, `${target.name}${suffix}.sql`);
}
