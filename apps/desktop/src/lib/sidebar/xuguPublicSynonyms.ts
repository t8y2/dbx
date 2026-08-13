/**
 * Xugu public synonyms do not belong to a user schema. The agent exposes
 * them through this reserved protocol scope so the schema tree can keep a
 * real schema named GUEST independent from database-global aliases.
 */
export const XUGU_PUBLIC_SYNONYM_SCOPE = "\u0000DBX_XUGU_PUBLIC_SYNONYMS";
export const XUGU_PUBLIC_SYNONYM_SCOPE_LABEL = "Public synonyms";

export function isXuguPublicSynonymScope(schema: string | null | undefined): boolean {
  return schema === XUGU_PUBLIC_SYNONYM_SCOPE;
}

export function xuguSchemaDisplayName(schema: string): string {
  return isXuguPublicSynonymScope(schema) ? XUGU_PUBLIC_SYNONYM_SCOPE_LABEL : schema;
}

export function isXuguPublicSynonymTreeNode(databaseType: string | null | undefined, nodeType: string, schema: string | null | undefined): boolean {
  return databaseType === "xugu" && nodeType === "schema" && isXuguPublicSynonymScope(schema);
}
