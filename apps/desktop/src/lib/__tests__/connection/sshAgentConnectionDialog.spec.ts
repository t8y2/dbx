import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("SSH agent connection form", () => {
  it("offers SSH agent for a new tunnel and exposes its custom socket path", () => {
    expect(dialogSource).toContain('<SelectItem value="agent">{{ t("connection.sshUseAgent") }}</SelectItem>');
    expect(dialogSource).toContain('<div v-if="selectedSshLayer.auth_method === \'agent\'" class="grid grid-cols-4 items-center gap-4">');
    expect(dialogSource).toContain('v-model="selectedSshLayer.ssh_agent_sock_path"');
    expect(dialogSource).not.toContain('v-if="isLegacySshAgentMethod(selectedSshLayer)" value="agent" disabled');
  });
});
