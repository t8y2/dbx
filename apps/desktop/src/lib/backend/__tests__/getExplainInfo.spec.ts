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
