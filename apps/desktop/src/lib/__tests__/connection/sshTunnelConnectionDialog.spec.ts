import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("ConnectionDialog SSH tunnel test", () => {
  it("exposes a dedicated SSH tunnel test without running the database test", () => {
    expect(dialogSource).toContain("async function testSshTunnel()");
    expect(dialogSource).toContain("await api.testSshTunnel(config)");
    expect(dialogSource).toContain('@click="testSshTunnel"');
    expect(dialogSource).toContain('t("connection.sshTunnelTest")');
  });

  it("builds the tunnel probe config without database-specific validation", () => {
    const start = dialogSource.indexOf("function connectionConfigForSshTunnelTest");
    const end = dialogSource.indexOf("function connectionConfigForSubmit", start);
    const helperSource = dialogSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(helperSource).toContain("normalizeTransportLayersForSubmit(config)");
    expect(helperSource).not.toContain("kingbaseDatabaseRequired");
    expect(helperSource).not.toContain("dynamodbCredentialsRequired");
  });
});
