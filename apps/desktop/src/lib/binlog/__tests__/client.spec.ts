import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), desktop: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => mocks.desktop }));
import { requestBinlog, cancelBinlog, positionFilter } from "../client";
describe("binlog Desktop IPC", () => {
  beforeEach(() => {
    mocks.desktop = true;
    mocks.invoke.mockReset();
  });
  it("retains precision strings and uses only the isolated worker command", async () => {
    mocks.invoke.mockResolvedValue(JSON.stringify({ value: "18446744073709551615" }));
    expect(await requestBinlog({ action: "details", path: "a.binlog", sha256: "hash", start_position: "207" }, "id")).toEqual({ value: "18446744073709551615" });
    expect(mocks.invoke).toHaveBeenCalledWith("binlog_recovery_request", { requestId: "id", request: JSON.stringify({ action: "details", path: "a.binlog", sha256: "hash", start_position: "207" }) });
  });
  it("refuses Web without sending an IPC request", async () => {
    mocks.desktop = false;
    await expect(requestBinlog({ action: "list", path: "a" }, "id")).rejects.toThrow("Desktop only");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("cancels only the supplied request identity", async () => {
    mocks.invoke.mockResolvedValue(true);
    await cancelBinlog("owned-id");
    expect(mocks.invoke).toHaveBeenCalledWith("binlog_recovery_cancel", { requestId: "owned-id" });
  });
  it("never rounds or accepts malformed position filters", () => {
    expect(positionFilter("")).toBeUndefined();
    expect(positionFilter("4294967295")).toBe(4294967295);
    for (const value of ["9007199254740993", "-1", "1e3", "1.5", "x"]) expect(() => positionFilter(value)).toThrow();
  });
});
