import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONNECT_TIMEOUT_SECS, normalizeConnectTimeoutSecs } from "@/lib/connection/timeoutLimits";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("ConnectionDialog timeout controls", () => {
  it("uses separate maximums for connection and query timeouts", () => {
    expect(dialogSource).toMatch(/v-model\.number="editGlobalConnectTimeoutSecs"[\s\S]*?min="1"[\s\S]*?:max="MAX_CONNECT_TIMEOUT_SECS"[\s\S]*?step="1"/);
    expect(dialogSource).toMatch(/v-model\.number="form\.connect_timeout_secs"[\s\S]*?min="1"[\s\S]*?:max="MAX_CONNECT_TIMEOUT_SECS"[\s\S]*?step="1"/);
    expect(dialogSource).toMatch(/v-model\.number="editGlobalQueryTimeoutSecs"[\s\S]*?min="0"[\s\S]*?:max="MAX_QUERY_TIMEOUT_SECS"[\s\S]*?step="1"/);
    expect(dialogSource).toMatch(/v-model\.number="form\.query_timeout_secs"[\s\S]*?min="0"[\s\S]*?:max="MAX_QUERY_TIMEOUT_SECS"[\s\S]*?step="1"/);
    expect(dialogSource).not.toContain('v-model.number="editGlobalQueryTimeoutSecs" type="number" min="0" max="300"');
    expect(dialogSource).not.toContain('v-model.number="form.query_timeout_secs" type="number" min="0" max="300"');
    expect(dialogSource).toContain("@input=\"clampQueryTimeoutInput($event, 'global')\"");
    expect(dialogSource).toContain("@input=\"clampQueryTimeoutInput($event, 'connection')\"");
    expect(dialogSource).toContain("@input=\"clampConnectTimeoutInput($event, 'global')\"");
    expect(dialogSource).toContain("@input=\"clampConnectTimeoutInput($event, 'connection')\"");
    expect(dialogSource).not.toContain('@blur="editGlobalQueryTimeoutSecs = normalizeGlobalQueryTimeoutSecs');
  });

  it("restores the default when the connection timeout input is cleared", () => {
    expect(normalizeConnectTimeoutSecs("")).toBe(DEFAULT_CONNECT_TIMEOUT_SECS);
    expect(dialogSource).toContain("normalizeGlobalConnectTimeoutSecs(config.connect_timeout_secs)");
    expect(dialogSource).not.toContain("Number(config.connect_timeout_secs)");
  });

  it("shows range help beside both global timeout labels", () => {
    expect(dialogSource).toContain('t("connection.globalConnectTimeoutHint")');
    expect(dialogSource).toContain('t("connection.globalQueryTimeoutHint")');
  });
});
