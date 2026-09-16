import { describe, expect, it } from "vitest";
import type { SshTunnelConfig } from "@/types/database";
import { applySshAuthMethod, inferSshAuthMethod } from "../sshAuthMethod";

function sshLayer(overrides: Partial<SshTunnelConfig> = {}): SshTunnelConfig {
  return {
    id: "ssh-1",
    host: "jump.example.com",
    port: 22,
    user: "root",
    password: "password-secret",
    key_path: "~/.ssh/id_ed25519",
    key_passphrase: "key-secret",
    use_ssh_agent: false,
    ssh_agent_sock_path: "/custom/agent.sock",
    auth_method: "password",
    ...overrides,
  };
}

describe("SSH authentication method state", () => {
  it("enables agent authentication while preserving its custom socket", () => {
    const layer = sshLayer();

    applySshAuthMethod(layer, "agent");

    expect(layer).toMatchObject({
      auth_method: "agent",
      use_ssh_agent: true,
      ssh_agent_sock_path: "/custom/agent.sock",
      password: "",
      key_path: "",
      key_passphrase: "",
    });
  });

  it.each([
    ["password", "password-secret", "", ""],
    ["key", "", "~/.ssh/id_ed25519", "key-secret"],
    ["key+password", "password-secret", "~/.ssh/id_ed25519", "key-secret"],
    ["none", "", "", ""],
  ] as const)("disables agent when switching to %s", (method, password, keyPath, keyPassphrase) => {
    const layer = sshLayer({ auth_method: "agent", use_ssh_agent: true });

    applySshAuthMethod(layer, method);

    expect(layer.auth_method).toBe(method);
    expect(layer.use_ssh_agent).toBe(false);
    expect(layer.password).toBe(password);
    expect(layer.key_path).toBe(keyPath);
    expect(layer.key_passphrase).toBe(keyPassphrase);
    expect(layer.ssh_agent_sock_path).toBe("/custom/agent.sock");
  });

  it("infers agent for a legacy connection without an auth method", () => {
    const layer = sshLayer({ auth_method: undefined, password: "", key_path: "", use_ssh_agent: true });

    expect(inferSshAuthMethod(layer)).toBe("agent");
    expect(layer.ssh_agent_sock_path).toBe("/custom/agent.sock");
  });
});
