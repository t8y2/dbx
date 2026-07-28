import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { applySshConfigHostAliasPrefill } from "../../apps/desktop/src/lib/connection/sshConfigHosts.ts";
import type { SshTunnelConfig } from "../../apps/desktop/src/types/database.ts";

function sshConfig(overrides: Partial<SshTunnelConfig> = {}): SshTunnelConfig {
  return {
    id: "ssh-1",
    host: "production",
    port: 22,
    user: "root",
    password: "",
    key_path: "",
    key_passphrase: "",
    connect_timeout_secs: 5,
    expose_lan: false,
    auth_method: "password",
    ...overrides,
  };
}

const hosts = [
  {
    alias: "production",
    host_name: "10.0.0.5",
    port: 2222,
    user: "deploy",
    identity_file: "~/.ssh/production_ed25519",
  },
];

test("prefills default SSH fields from a selected config alias", () => {
  const target = sshConfig();

  applySshConfigHostAliasPrefill(target, hosts);

  assert.equal(target.host, "production");
  assert.equal(target.port, 2222);
  assert.equal(target.user, "deploy");
  assert.equal(target.key_path, "~/.ssh/production_ed25519");
  assert.equal(target.auth_method, "key");
});

test("does not overwrite explicit SSH form values", () => {
  const target = sshConfig({ port: 2200, user: "admin", password: "secret", key_path: "~/.ssh/custom" });

  applySshConfigHostAliasPrefill(target, hosts);

  assert.equal(target.port, 2200);
  assert.equal(target.user, "admin");
  assert.equal(target.key_path, "~/.ssh/custom");
  assert.equal(target.auth_method, "password");
});

test("leaves the form unchanged when no config alias matches", () => {
  const target = sshConfig({ host: "unknown" });
  const before = structuredClone(target);

  applySshConfigHostAliasPrefill(target, hosts);

  assert.deepEqual(target, before);
});

test("loads and exposes SSH config aliases in tunnel profile maintenance", () => {
  const component = readFileSync(path.resolve("apps/desktop/src/components/connection/TunnelProfileManager.vue"), "utf8");

  assert.match(component, /api\.listSshConfigHosts\(\)/);
  assert.match(component, /list="tunnel-profile-ssh-config-host-aliases"/);
  assert.match(component, /<datalist id="tunnel-profile-ssh-config-host-aliases">/);
  assert.match(component, /@update:model-value="updateSelectedSshHost"/);
});
