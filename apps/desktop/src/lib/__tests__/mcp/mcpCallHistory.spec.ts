import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { MCP_CALL_HISTORY_OPEN_EVENT, mcpRequestSql, openMcpCallHistory } from "@/lib/mcp/mcpCallHistory";

const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const historySource = readFileSync(new URL("../../../components/editor/QueryHistory.vue", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../../../components/editor/EditorSettingsDialog.vue", import.meta.url), "utf8");

describe("MCP call history entry point", () => {
  it("dispatches the open event", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const listener = vi.fn();
    target.addEventListener(MCP_CALL_HISTORY_OPEN_EVENT, listener);
    openMcpCallHistory();
    vi.unstubAllGlobals();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("carries a resource filter when opened from the access tree", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const listener = vi.fn();
    target.addEventListener(MCP_CALL_HISTORY_OPEN_EVENT, listener);
    openMcpCallHistory({ connectionId: "c1", database: "analytics" });
    vi.unstubAllGlobals();
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ connectionId: "c1", database: "analytics" });
  });

  it("is wired from settings to the app shell to the history panel", () => {
    // The settings handler defers navigation until the close guard allows it.
    expect(settingsSource).toContain('@click="requestMcpCallHistory()"');
    expect(appSource).toContain("window.addEventListener(MCP_CALL_HISTORY_OPEN_EVENT, openMcpCallHistory)");
    expect(appSource).toContain(':mcp-request="mcpHistoryRequest"');
    expect(appSource).toContain('@mcp-request-handled="mcpHistoryRequest = null"');
    expect(historySource).toContain("() => props.mcpRequest");
    expect(historySource).toContain("applyMcpResource");
  });

  it("shows the recorded MCP client in the history detail", () => {
    expect(historySource).toContain('t("history.detail.mcpClient")');
    expect(historySource).toContain("function mcpClientLabel(entry: HistoryEntry)");
  });
});

describe("mcpRequestSql", () => {
  it.each([
    ["a sql string", JSON.stringify({ connection: "c1", sql: "SELECT 1" }), "SELECT 1"],
    ["a list of statements", JSON.stringify({ sql: ["SELECT 1;", "", "SELECT 2;"] }), "SELECT 1;\nSELECT 2;"],
    ["a multi-line script", JSON.stringify({ sql: "UPDATE t\nSET a = 1;" }), "UPDATE t\nSET a = 1;"],
  ])("reads %s", (_name, request, expected) => {
    expect(mcpRequestSql(request)).toBe(expected);
  });

  it.each([
    ["no request", undefined],
    ["an empty request", ""],
    ["invalid JSON", "{not json"],
    ["a request without sql (list_tables)", JSON.stringify({ connection: "c1" })],
    ["a blank sql string", JSON.stringify({ sql: "   " })],
    ["a non-string sql", JSON.stringify({ sql: 42 })],
    ["a list without strings", JSON.stringify({ sql: [1, null] })],
    ["a truncated-request summary", JSON.stringify({ truncated: true, summary: "Request exceeds history size limit" })],
  ])("returns null for %s", (_name, request) => {
    expect(mcpRequestSql(request)).toBeNull();
  });
});
