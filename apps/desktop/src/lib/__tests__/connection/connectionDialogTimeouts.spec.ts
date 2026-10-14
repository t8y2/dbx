import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONNECT_TIMEOUT_SECS, DEFAULT_IDLE_TIMEOUT_SECS, MAX_IDLE_TIMEOUT_SECS, normalizeConnectTimeoutSecs, normalizeIdleTimeoutSecs, supportsIdleTimeout } from "@/lib/connection/timeoutLimits";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("ConnectionDialog timeout controls", () => {
  it("restores the default when the connection timeout input is cleared", () => {
    expect(normalizeConnectTimeoutSecs("")).toBe(DEFAULT_CONNECT_TIMEOUT_SECS);
  });

  it("normalizes and bounds idle timeout values", () => {
    expect(normalizeIdleTimeoutSecs("")).toBe(DEFAULT_IDLE_TIMEOUT_SECS);
    expect(normalizeIdleTimeoutSecs(Number.NaN)).toBe(DEFAULT_IDLE_TIMEOUT_SECS);
    expect(normalizeIdleTimeoutSecs(-1)).toBe(DEFAULT_IDLE_TIMEOUT_SECS);
    expect(normalizeIdleTimeoutSecs(0)).toBe(0);
    expect(normalizeIdleTimeoutSecs(60)).toBe(60);
    expect(normalizeIdleTimeoutSecs(120.4)).toBe(120);
    expect(normalizeIdleTimeoutSecs(5000)).toBe(MAX_IDLE_TIMEOUT_SECS);
  });

  it("identifies database dialects that support idle connection timeouts", () => {
    expect(supportsIdleTimeout("mongodb")).toBe(true);
    expect(supportsIdleTimeout("mysql")).toBe(true);
    expect(supportsIdleTimeout("doris")).toBe(true);
    expect(supportsIdleTimeout("starrocks")).toBe(true);
    expect(supportsIdleTimeout("manticoresearch")).toBe(true);

    expect(supportsIdleTimeout("postgres")).toBe(false);
    expect(supportsIdleTimeout("sqlite")).toBe(false);
    expect(supportsIdleTimeout("redis")).toBe(false);
    expect(supportsIdleTimeout("sqlserver")).toBe(false);
    expect(supportsIdleTimeout("oracle")).toBe(false);
    expect(supportsIdleTimeout(undefined)).toBe(false);
  });

  it("binds idle timeout setting and hint in ConnectionDialog", () => {
    expect(dialogSource).toContain('v-show="supportsIdleTimeoutSetting"');
    expect(dialogSource).toContain("clampIdleTimeoutInput($event)");
    expect(dialogSource).toContain('t("connection.idleTimeoutHint")');
  });
});
