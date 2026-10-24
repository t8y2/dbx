import type { DatabaseType, MetadataReadOptions, ObjectInfo, OracleTriggerMetadata, TriggerInfo, TreeNode } from "@/types/database";
import { effectiveDatabaseTypeForConnection, type JdbcDialectConnection } from "@/lib/database/jdbcDialect";

/** A read request is not an engine capability proof; the response must verify it. */
export function oracleTriggerReadOptions(databaseType?: DatabaseType, catalog?: string): MetadataReadOptions | undefined {
  if (databaseType !== "oracle" && databaseType !== "oceanbase-oracle" && databaseType !== "dameng") return;
  return { identityMode: "exact", ...(catalog === undefined ? {} : { catalog }) };
}

export function oracleTriggerObjectReadOptions(connection: JdbcDialectConnection | undefined, objectTypes?: readonly string[], catalog?: string): MetadataReadOptions | undefined {
  if (objectTypes && !objectTypes.includes("TRIGGER")) return;
  // A broad compatibility label may suggest a new trigger-only read. It must
  // not impose new provider requirements on existing mixed/parent reads.
  if (connection?.db_type === "jdbc" && !(objectTypes?.length === 1 && objectTypes[0] === "TRIGGER")) {
    const product = connection.database_info?.productName?.toLowerCase();
    if (!product || !["oracle", "oracle database", "oceanbase", "dm dbms", "dm8", "dameng"].includes(product)) return;
  }
  return oracleTriggerReadOptions(effectiveDatabaseTypeForConnection(connection), catalog);
}

/** This establishes the provider's identity semantics, not permission to write. */
export function exactOracleTriggerMetadata(trigger?: Pick<TriggerInfo, "name" | "oracle_metadata"> | null): OracleTriggerMetadata | undefined {
  const metadata = trigger?.oracle_metadata;
  if (!metadata || metadata.contractVersion !== 1 || metadata.identityMode !== "exact") return;
  if (!["oracle", "oceanbase-oracle", "dm"].includes(metadata.engine)) return;
  if (typeof metadata.owner !== "string" || metadata.owner.length === 0 || typeof metadata.name !== "string" || metadata.name.length === 0 || metadata.name !== trigger?.name) return;
  return metadata;
}

export function exactOracleTriggerObjectMetadata(object: ObjectInfo): OracleTriggerMetadata | undefined {
  if (object.object_type.toUpperCase() !== "TRIGGER") return;
  const metadata = exactOracleTriggerMetadata(object.trigger);
  if (!metadata || metadata.name !== object.name || (object.schema != null && metadata.owner !== object.schema)) return;
  return metadata;
}

/** Encoded raw tuples avoid delimiter collisions and preserve quoted case. */
export function oracleTriggerIdentityKey(metadata: Pick<OracleTriggerMetadata, "owner" | "name">, catalog?: string): string {
  return JSON.stringify(["oracle-trigger/v1", catalog ?? null, metadata.owner, metadata.name]);
}

export function exactOracleTriggerNodeMetadata(node: Pick<TreeNode, "type" | "meta" | "schema" | "objectName">): OracleTriggerMetadata | undefined {
  if (node.type !== "trigger" || !node.meta || !("oracle_metadata" in node.meta) || !("event" in node.meta) || !("timing" in node.meta)) return;
  const metadata = exactOracleTriggerMetadata(node.meta);
  if (!metadata || metadata.owner !== node.schema || metadata.name !== node.objectName) return;
  return metadata;
}
