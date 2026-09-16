export type PostgresTlsMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";

export const POSTGRES_LEGACY_TLS_PARAM = "legacy_tls";

export function postgresTlsModeForForm(value: string | undefined, ssl: boolean | undefined): PostgresTlsMode {
  switch ((value || "").trim().toLowerCase()) {
    case "disable":
    case "prefer":
    case "require":
    case "verify-ca":
    case "verify-full":
      return value!.trim().toLowerCase() as PostgresTlsMode;
    case "verify_identity":
    case "verify-identity":
      return "verify-full";
    default:
      // Align with libpq/JDBC: absent mode prefers TLS and can fall back to plaintext.
      // Legacy ssl=true still maps to require.
      return ssl ? "require" : "prefer";
  }
}

export function postgresLegacyTlsEnabled(params: string | undefined): boolean {
  const parsed = new URLSearchParams((params || "").trim().replace(/^\?/, ""));
  return ["1", "true", "yes", "on"].includes((parsed.get(POSTGRES_LEGACY_TLS_PARAM) || "").trim().toLowerCase());
}

export function setPostgresLegacyTlsEnabled(params: string | undefined, enabled: boolean): string {
  const parsed = new URLSearchParams((params || "").trim().replace(/^\?/, ""));
  if (enabled) parsed.set(POSTGRES_LEGACY_TLS_PARAM, "true");
  else parsed.delete(POSTGRES_LEGACY_TLS_PARAM);
  return parsed.toString();
}
