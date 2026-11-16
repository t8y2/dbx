export const CNOSDB_DEFAULT_TENANT = "cnosdb";

export function cnosdbTenantFromExternalConfig(externalConfig: unknown): string {
  if (!externalConfig || typeof externalConfig !== "object" || Array.isArray(externalConfig)) {
    return CNOSDB_DEFAULT_TENANT;
  }
  const tenant = (externalConfig as Record<string, unknown>).tenant;
  return typeof tenant === "string" && tenant.trim() ? tenant.trim() : CNOSDB_DEFAULT_TENANT;
}

export function applyCnosdbTenantToExternalConfig(externalConfig: unknown, tenant: string): Record<string, unknown> | undefined {
  const next = externalConfig && typeof externalConfig === "object" && !Array.isArray(externalConfig) ? { ...(externalConfig as Record<string, unknown>) } : {};
  const trimmed = tenant.trim();
  if (!trimmed || trimmed === CNOSDB_DEFAULT_TENANT) {
    delete next.tenant;
  } else {
    next.tenant = trimmed;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
