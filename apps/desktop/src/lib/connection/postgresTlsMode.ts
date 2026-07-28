export type PostgresTlsMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";

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
