import type { MqAuth, MqSystemKind } from "@/types/mq";

export type MqAuthKind = MqAuth["kind"];
export type MqUiAuthKind = MqAuthKind | "kerberos";

const KAFKA_AUTH_KINDS = new Set<MqUiAuthKind>(["none", "basic", "kerberos"]);
const ROCKETMQ_AUTH_KINDS = new Set<MqUiAuthKind>(["none", "basic"]);
const RABBITMQ_AUTH_KINDS = new Set<MqUiAuthKind>(["none", "basic"]);
const NATS_AUTH_KINDS = new Set<MqUiAuthKind>(["none", "basic", "token"]);

export function isMqAuthKindAllowedForSystem(systemKind: MqSystemKind, authKind: MqUiAuthKind): boolean {
  if (systemKind === "kafka") return KAFKA_AUTH_KINDS.has(authKind);
  if (systemKind === "rocketmq") return ROCKETMQ_AUTH_KINDS.has(authKind);
  if (systemKind === "rabbitmq") return RABBITMQ_AUTH_KINDS.has(authKind);
  if (systemKind === "nats") return NATS_AUTH_KINDS.has(authKind);
  return authKind !== "kerberos";
}

export function detectMqUiAuthKind({ systemKind, authKind, saslMechanism, jaasConfig }: { systemKind: MqSystemKind; authKind?: MqAuthKind; saslMechanism: string; jaasConfig: string }): MqUiAuthKind {
  if (systemKind === "kafka") {
    if (saslMechanism.toUpperCase() === "GSSAPI" && jaasConfig.includes("Krb5LoginModule")) {
      return "kerberos";
    }
    return authKind === "basic" ? "basic" : "none";
  }
  if (systemKind === "rocketmq") {
    return authKind === "basic" ? "basic" : "none";
  }
  if (systemKind === "rabbitmq") {
    return authKind === "basic" ? "basic" : "none";
  }
  if (systemKind === "nats") {
    return authKind === "basic" || authKind === "token" ? authKind : "none";
  }

  return authKind || "none";
}
