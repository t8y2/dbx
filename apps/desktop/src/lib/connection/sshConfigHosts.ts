import type { SshConfigHostEntry, SshTunnelConfig } from "@/types/database";

const DEFAULT_SSH_USER = "root";
const DEFAULT_SSH_PORT = 22;

/**
 * Prefills an SSH form from a matching ~/.ssh/config alias without
 * overwriting values the user already changed away from the form defaults.
 * The Rust backend remains responsible for authoritative alias resolution at
 * connect time; this helper only keeps the form preview consistent.
 */
export function applySshConfigHostAliasPrefill(target: SshTunnelConfig, hosts: readonly SshConfigHostEntry[]): void {
  const entry = hosts.find((candidate) => candidate.alias === target.host);
  if (!entry) return;
  if (target.user === DEFAULT_SSH_USER && entry.user) target.user = entry.user;
  if (target.port === DEFAULT_SSH_PORT && entry.port) target.port = entry.port;
  if (!target.key_path && entry.identity_file) {
    target.key_path = entry.identity_file;
    if ((!target.auth_method || target.auth_method === "password") && !target.password?.trim()) {
      target.auth_method = "key";
    }
  }
}
