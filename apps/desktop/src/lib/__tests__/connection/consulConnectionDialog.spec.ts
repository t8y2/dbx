import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

function section(startMarker: string, endMarker: string): string {
  const start = dialogSource.indexOf(startMarker);
  const end = dialogSource.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return dialogSource.slice(start, end);
}

describe("Consul connection dialog", () => {
  it("keeps Operator feature switches in the Consul form instead of the JDBC form", () => {
    const jdbcForm = section("<!-- JDBC: optional external plugin -->", "<!-- Local database files: file path only -->");
    const consulForm = section("<!-- Consul KV: HTTP endpoint, ACL token and scope -->", "<!-- etcd: endpoints, user, password, TLS -->");
    const operatorModels = ["consulOperatorVisible", "consulOperatorSnapshotRestoreEnabled", "consulOperatorAutopilotWriteEnabled", "consulOperatorRaftWriteEnabled", "consulOperatorKeyringWriteEnabled", "consulOperatorLicenseWriteEnabled"];

    for (const model of operatorModels) {
      expect(jdbcForm).not.toContain(`v-model="${model}"`);
      expect(consulForm).toContain(`v-model="${model}"`);
    }
  });
});
