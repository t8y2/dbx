import type { TreeNode, DatabaseType, CustomTypeTreeMemberMeta } from "@/types/database";
import { isTreeGroupNodeType } from "@/lib/sidebar/treeNodeGroup";
import { xuguSchemaDisplayName } from "@/lib/sidebar/xuguPublicSynonyms";
import { elasticsearchIndexAliasLabel } from "@/lib/sidebar/elasticsearchIndexActions";
import { supportsOracleTypeAttributeExpansion } from "@/lib/database/databaseObjectCapabilities";
export type SidebarTreeTranslate = (key: string, values?: Record<string, number>) => string;

export function sidebarTreeDisplayLabel(node: TreeNode, t: SidebarTreeTranslate, databaseType?: DatabaseType): string {
  // Synthetic Xugu scopes are persisted with their reserved protocol value.
  // Resolve them at render time as well, so an already-cached tree never
  // exposes that implementation detail after the feature is introduced.
  if (node.type === "schema" && node.connectionId) {
    if (databaseType === "xugu") return xuguSchemaDisplayName(node.schema ?? node.label);
  }
  if (node.type === "load-more") return node.loadMore?.objectType === "INDEX" ? `${t("tree.indexes")} · ${t(node.label)}` : t(node.label);
  if (node.type === "object-browser") return t(node.label, { count: node.objectCount ?? 0 });
  // Use the canonical key for persisted trees created before this label was
  // internationalized; those nodes may still contain the old Chinese text.
  if (node.type === "nacos-access-control") return t("nacos.accessControlSidebarLabel");
  if (node.type === "user-admin" || node.type === "xugu-user-admin" || node.type === "dameng-users" || node.type === "dameng-roles" || node.type === "dameng-job-admin" || node.type === "database-job-admin" || node.type === "meilisearch-system") return t(node.label);
  if (node.type === "oracle-db-links" || node.type === "linked-server-root") return t(node.label);
  if (node.type === "saved-sql-root") return t(node.label);
  if (node.type === "mqtt-topic" && node.id.endsWith(":mqtt-topic:__console__")) return t(node.label);
  if (node.label === "tree.defaultDatabase") return t(node.label);
  return isTreeGroupNodeType(node.type) ? t(node.label) : node.label;
}

export function sidebarTreeSecondaryValue(node: TreeNode, t: SidebarTreeTranslate, databaseType?: DatabaseType): string | undefined {
  if (node.type === "type" && node.customTypeKind) {
    const kindKey = supportsOracleTypeAttributeExpansion(databaseType) ? `oracleType.kinds.${node.customTypeKind in { object: true, collection: true } ? node.customTypeKind : "other"}` : `customType.kinds.${node.customTypeKind}`;
    return t(kindKey);
  }
  if (node.type === "type-member") return (node.meta as CustomTypeTreeMemberMeta | undefined)?.displayValue;
  if (node.type === "datafile") return node.xuguDatafilePath;
  if (node.type === "elasticsearch-index") return elasticsearchIndexAliasLabel(node);
  return undefined;
}
