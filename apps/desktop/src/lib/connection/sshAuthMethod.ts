import type { SshTunnelConfig } from "@/types/database";

export type SshAuthMethod = NonNullable<SshTunnelConfig["auth_method"]>;

export function inferSshAuthMethod(hop: Partial<SshTunnelConfig>): SshAuthMethod {
  if (hop.key_path?.trim()) return "key";
  if (hop.password) return "password";
  if (hop.use_ssh_agent) return "agent";
  return "none";
}

export function applySshAuthMethod(layer: SshTunnelConfig, value: unknown) {
  const method: SshAuthMethod = value === "key" ? "key" : value === "key+password" ? "key+password" : value === "agent" ? "agent" : value === "none" ? "none" : "password";
  layer.auth_method = method;
  layer.use_ssh_agent = method === "agent";

  if (method !== "password" && method !== "key+password") layer.password = "";
  if (method !== "key" && method !== "key+password") {
    layer.key_path = "";
    layer.key_passphrase = "";
  }
}
