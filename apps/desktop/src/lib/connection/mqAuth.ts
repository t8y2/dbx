import type { MqAuth, MqSystemKind } from "@/types/mq";

export type MqAuthKind = MqAuth["kind"];
export type MqUiAuthKind = MqAuthKind | "kerberos";

const KAFKA_AUTH_KINDS = new Set<MqUiAuthKind>(["none", "basic", "kerberos"]);

export function isMqAuthKindAllowedForSystem(systemKind: MqSystemKind, authKind: MqUiAuthKind): boolean {
  if (systemKind === "kafka") return KAFKA_AUTH_KINDS.has(authKind);
  return authKind !== "kerberos";
}

export function detectMqUiAuthKind({ systemKind, authKind, saslMechanism, jaasConfig }: { systemKind: MqSystemKind; authKind?: MqAuthKind; saslMechanism: string; jaasConfig: string }): MqUiAuthKind {
  if (systemKind === "kafka") {
    if (saslMechanism.toUpperCase() === "GSSAPI" && jaasConfig.includes("Krb5LoginModule")) {
      return "kerberos";
    }
    return authKind === "basic" ? "basic" : "none";
  }

  return authKind || "none";
}
