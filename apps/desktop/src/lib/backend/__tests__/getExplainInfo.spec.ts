import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

describe("getExplainInfo backend error propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves Tauri command errors", async () => {
    const error = new Error("ORA-01031: insufficient privileges");
    mocks.invoke.mockRejectedValue(error);
    const { getExplainInfo } = await import("@/lib/backend/tauri");

    await expect(getExplainInfo("oracle-1", "ORCL", "APP", "SELECT * FROM DUAL", "explain")).rejects.toBe(error);
  });

  it("preserves HTTP response errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        text: vi.fn().mockResolvedValue("Agent error: PLAN_TABLE is not accessible"),
      }),
    );
    const { getExplainInfo } = await import("@/lib/backend/http");

    await expect(getExplainInfo("oracle-1", "ORCL", "APP", "SELECT * FROM DUAL", "explain")).rejects.toThrow("Agent error: PLAN_TABLE is not accessible");
  });
});

describe("native explain cancellation transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("passes an execution ID to the Tauri backend while preserving legacy arguments", async () => {
    mocks.invoke.mockResolvedValue("{}");
    const { getExplainInfo } = await import("@/lib/backend/tauri");
    await getExplainInfo("db2-1", "DBX8834", "APP_A", "SELECT 1", "explain", "execution-1");
    expect(mocks.invoke).toHaveBeenLastCalledWith("get_explain_info", { connectionId: "db2-1", database: "DBX8834", schema: "APP_A", sql: "SELECT 1", mode: "explain", executionId: "execution-1" });
    await getExplainInfo("oracle-1", "ORCL", "APP", "SELECT 1", "explain");
    expect(mocks.invoke).toHaveBeenLastCalledWith("get_explain_info", { connectionId: "oracle-1", database: "ORCL", schema: "APP", sql: "SELECT 1", mode: "explain" });
  });

  it("passes an execution ID through the HTTP adapter", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue("{}") });
    vi.stubGlobal("fetch", fetch);
    const { getExplainInfo } = await import("@/lib/backend/http");
    await getExplainInfo("db2-1", "DBX8834", "APP_A", "SELECT 1", "explain", "execution-2");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ connectionId: "db2-1", database: "DBX8834", schema: "APP_A", sql: "SELECT 1", mode: "explain", executionId: "execution-2" });
    await getExplainInfo("oracle-1", "ORCL", "APP", "SELECT 1", "explain");
    expect(JSON.parse(fetch.mock.calls[1][1].body)).not.toHaveProperty("executionId");
  });
});

describe("native explain timeout transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([7, 0])("passes the %s-second override through both adapters, including unlimited", async (timeoutSecs) => {
    mocks.invoke.mockResolvedValue("{}");
    const { getExplainInfo: tauriExplain } = await import("@/lib/backend/tauri");
    await tauriExplain("db2-1", "DBX8834", "APP_A", "SELECT 1", "explain", "execution-1", timeoutSecs);
    expect(mocks.invoke).toHaveBeenLastCalledWith("get_explain_info", { connectionId: "db2-1", database: "DBX8834", schema: "APP_A", sql: "SELECT 1", mode: "explain", executionId: "execution-1", timeoutSecs });
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue("{}") });
    vi.stubGlobal("fetch", fetch);
    const { getExplainInfo: httpExplain } = await import("@/lib/backend/http");
    await httpExplain("db2-1", "DBX8834", "APP_A", "SELECT 1", "explain", "execution-2", timeoutSecs);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ connectionId: "db2-1", database: "DBX8834", schema: "APP_A", sql: "SELECT 1", mode: "explain", executionId: "execution-2", timeoutSecs });
  });
});
