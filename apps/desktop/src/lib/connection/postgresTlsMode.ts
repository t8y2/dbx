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
      // DBX and DBeaver expose TLS as opt-in; an absent mode must remain plaintext.
      return ssl ? "require" : "disable";
  }
}
