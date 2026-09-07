import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const managerSource = readFileSync(new URL("../../../components/connection/TunnelProfileManager.vue", import.meta.url), "utf8");

describe("SSH agent tunnel profile form", () => {
  it("offers the same SSH agent login method as the connection editor", () => {
    expect(managerSource).toContain('<SelectItem value="agent">{{ t("connection.sshUseAgent") }}</SelectItem>');
  });

  it("exposes the custom agent socket path while keeping the shared auth mapping", () => {
    expect(managerSource).toContain(`<div v-if="selectedSsh.auth_method === 'agent'" class="grid grid-cols-4 items-center gap-4">`);
    expect(managerSource).toContain('v-model="selectedSsh.ssh_agent_sock_path"');
    expect(managerSource).toContain('import { applySshAuthMethod } from "@/lib/connection/sshAuthMethod";');
    expect(managerSource).toContain("applySshAuthMethod(profile, value);");
  });

  it("does not keep a second auth-method mapping that could drift from applySshAuthMethod", () => {
    expect(managerSource).not.toContain('value === "key+password" ? "key+password"');
  });
});
