import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { groupMcpScopeConnections, isMcpPolicyMutationBlocked, matchesMcpSearchQuery, MCP_CAPABILITY_ROWS, MCP_EXECUTION_MODE_COLUMNS, mcpExecutionModeFromPolicy, mcpPolicyFieldsForExecutionMode, toggleMcpAllowedConnectionId, updateMcpAllowedConnectionIds } from "@/lib/mcp/mcpPolicySelection";

const settingsDialogSource = readFileSync(new URL("../../../components/editor/EditorSettingsDialog.vue", import.meta.url), "utf8");
const scopePickerSource = readFileSync(new URL("../../../components/settings/McpConnectionScopePicker.vue", import.meta.url), "utf8");

describe("MCP execution permission selection", () => {
  it("maps the persisted policy to the three UI modes", () => {
    expect(mcpExecutionModeFromPolicy({ readOnly: true, allowDangerousSql: false })).toBe("read_only");
    expect(mcpExecutionModeFromPolicy({ readOnly: false, allowDangerousSql: false })).toBe("safe_write");
    expect(mcpExecutionModeFromPolicy({ readOnly: false, allowDangerousSql: true })).toBe("high_risk_write");
  });

  it("treats read-only as authoritative when legacy state also allows dangerous SQL", () => {
    expect(mcpExecutionModeFromPolicy({ readOnly: true, allowDangerousSql: true })).toBe("read_only");
  });

  it("maps every UI mode to a complete atomic policy update", () => {
    expect(mcpPolicyFieldsForExecutionMode("read_only")).toEqual({ readOnly: true, allowDangerousSql: false });
    expect(mcpPolicyFieldsForExecutionMode("safe_write")).toEqual({ readOnly: false, allowDangerousSql: false });
    expect(mcpPolicyFieldsForExecutionMode("high_risk_write")).toEqual({ readOnly: false, allowDangerousSql: true });
  });

  it("presents the stable internal modes as three user-facing columns", () => {
    expect(MCP_EXECUTION_MODE_COLUMNS.map((column) => column.mode)).toEqual(["read_only", "safe_write", "high_risk_write"]);
  });

  it("shows the risk-based capability boundary without changing enforcement semantics", () => {
    expect(MCP_CAPABILITY_ROWS).toEqual([
      { labelKey: "settings.mcpCapabilityRead", read_only: true, safe_write: true, high_risk_write: true },
      { labelKey: "settings.mcpCapabilityScopedMutation", read_only: false, safe_write: true, high_risk_write: true },
      { labelKey: "settings.mcpCapabilityBroadMutation", read_only: false, safe_write: false, high_risk_write: true },
      { labelKey: "settings.mcpCapabilitySchemaAdmin", read_only: false, safe_write: false, high_risk_write: true },
      { labelKey: "settings.mcpCapabilityConnectionManagement", read_only: false, safe_write: true, high_risk_write: true },
    ]);
  });
});

describe("MCP policy connection selection", () => {
  it("turns allow-all into an explicit list when one connection is removed", () => {
    expect(toggleMcpAllowedConnectionId(null, ["one", "two", "three"], "two", false)).toEqual(["one", "three"]);
  });

  it("updates an existing explicit allowlist", () => {
    expect(toggleMcpAllowedConnectionId(["one"], ["one", "two"], "two", true)).toEqual(["one", "two"]);
    expect(toggleMcpAllowedConnectionId(["one", "two"], ["one", "two"], "one", false)).toEqual(["two"]);
  });

  it("groups live and unavailable connections without losing source order", () => {
    const one = { id: "one", name: "One" };
    const two = { id: "two", name: "Two" };
    const three = { id: "three", name: "Three" };
    expect(groupMcpScopeConnections([one, two, three], ["three", "missing", "one"])).toEqual({
      allowed: [one, three],
      available: [two],
      unavailableAllowedIds: ["missing"],
    });
    expect(groupMcpScopeConnections([one, two], null)).toEqual({
      allowed: [one, two],
      available: [],
      unavailableAllowedIds: [],
    });
  });

  it("applies batch additions and removals while preserving unavailable IDs", () => {
    expect(updateMcpAllowedConnectionIds(["one", "missing"], ["one", "two", "three"], ["two", "three"], true)).toEqual(["one", "missing", "two", "three"]);
    expect(updateMcpAllowedConnectionIds(null, ["one", "two", "three"], ["one", "three"], false)).toEqual(["two"]);
  });
});

describe("MCP policy settings state", () => {
  it("blocks mutations while loading, saving, or displaying a load error", () => {
    expect(isMcpPolicyMutationBlocked({ loading: true, saving: false, loadError: "" })).toBe(true);
    expect(isMcpPolicyMutationBlocked({ loading: false, saving: true, loadError: "" })).toBe(true);
    expect(isMcpPolicyMutationBlocked({ loading: false, saving: false, loadError: "unavailable" })).toBe(true);
    expect(isMcpPolicyMutationBlocked({ loading: false, saving: false, loadError: "" })).toBe(false);
  });

  it("guards the mutation entry point and wires the shared disabled state to policy controls", () => {
    expect(settingsDialogSource).toContain("if (mcpPolicyControlsDisabled.value) return;");
    expect(settingsDialogSource).toContain(':disabled="mcpPolicyControlsDisabled"');
    expect(settingsDialogSource).toContain('@update:allowed-connection-ids="onMcpAllowedConnectionIdsChange"');
    expect(settingsDialogSource).toContain('<fieldset :disabled="mcpPolicyControlsDisabled"');

    const loadingStart = settingsDialogSource.indexOf("mcpPolicyLoading.value = true;");
    const policyLoad = settingsDialogSource.indexOf("await settingsStore.initMcpGlobalPolicy(true);");
    const loadingEnd = settingsDialogSource.indexOf("mcpPolicyLoading.value = false;", policyLoad);
    expect(loadingStart).toBeGreaterThan(-1);
    expect(loadingStart).toBeLessThan(policyLoad);
    expect(loadingEnd).toBeGreaterThan(policyLoad);
  });
});

describe("MCP connection search", () => {
  it("matches case-insensitively across text, numeric fields, and connection IDs", () => {
    const values = ["MySQL Local", "mysql", "127.0.0.1", 3306, "app_db", "connection-ABC"];
    expect(matchesMcpSearchQuery(" mysql ", values)).toBe(true);
    expect(matchesMcpSearchQuery("3306", values)).toBe(true);
    expect(matchesMcpSearchQuery("connection-abc", values)).toBe(true);
    expect(matchesMcpSearchQuery("postgres", values)).toBe(false);
  });

  it("treats an empty query as a match and can search unavailable IDs", () => {
    expect(matchesMcpSearchQuery("   ", [null, undefined])).toBe(true);
    expect(matchesMcpSearchQuery("missing-id", ["missing-id-123", "Previously selected connection (unavailable)"])).toBe(true);
  });

  it("uses responsive allowed and available panes with an allowed-first compact view", () => {
    expect(scopePickerSource).toContain('const compactPane = ref<ScopePane>("allowed")');
    expect(scopePickerSource).toContain('data-scope-pane="available"');
    expect(scopePickerSource).toContain('data-scope-pane="allowed"');
    expect(scopePickerSource).toContain("@container mcp-scope (min-width: 42rem)");
    expect(scopePickerSource).toContain("filteredUnavailableAllowedIds");
  });
});
