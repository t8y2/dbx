import { describe, expect, it, vi } from "vitest";
import { runAgentOfflineExportAction, runAgentOfflineExportFlow } from "@/lib/driverStore/agentOfflineExportFlow";

describe("runAgentOfflineExportFlow", () => {
  it("stops silently when destination selection is cancelled", async () => {
    const exportPackage = vi.fn();

    await expect(
      runAgentOfflineExportFlow({
        driverKeys: ["duckdb"],
        chooseDestination: vi.fn().mockResolvedValue(null),
        exportPackage,
      }),
    ).resolves.toBeNull();
    expect(exportPackage).not.toHaveBeenCalled();
  });

  it("exports the selected drivers to the chosen destination", async () => {
    const driverKeys = ["duckdb", "redis"];
    const exportPackage = vi.fn().mockResolvedValue({ driverCount: 2 });

    await expect(
      runAgentOfflineExportFlow({
        driverKeys,
        chooseDestination: vi.fn().mockResolvedValue("/tmp/dbx-agents.zip"),
        exportPackage,
      }),
    ).resolves.toEqual({
      destination: "/tmp/dbx-agents.zip",
      result: { driverCount: 2 },
    });
    expect(exportPackage).toHaveBeenCalledWith("/tmp/dbx-agents.zip", ["duckdb", "redis"]);

    driverKeys.push("kafka");
    expect(exportPackage.mock.calls[0]?.[1]).toEqual(["duckdb", "redis"]);
  });

  it("does not open the save dialog for an empty selection", async () => {
    const chooseDestination = vi.fn();
    const exportPackage = vi.fn();

    await expect(runAgentOfflineExportFlow({ driverKeys: [], chooseDestination, exportPackage })).resolves.toBeNull();
    expect(chooseDestination).not.toHaveBeenCalled();
    expect(exportPackage).not.toHaveBeenCalled();
  });

  it.each([
    ["destination selection", vi.fn().mockRejectedValue(new Error("save failed"))],
    ["package creation", vi.fn().mockResolvedValue("/tmp/dbx-agents.zip")],
  ])("propagates %s failures to the caller", async (stage, chooseDestination) => {
    const exportPackage = stage === "package creation" ? vi.fn().mockRejectedValue(new Error("export failed")) : vi.fn();

    await expect(
      runAgentOfflineExportFlow({
        driverKeys: ["duckdb"],
        chooseDestination,
        exportPackage,
      }),
    ).rejects.toThrow(stage === "destination selection" ? "save failed" : "export failed");
  });
});

describe("runAgentOfflineExportAction", () => {
  function createOptions(overrides: Partial<Parameters<typeof runAgentOfflineExportAction<{ driverCount: number }>>[0]> = {}) {
    return {
      driverKeys: ["duckdb"],
      chooseDestination: vi.fn().mockResolvedValue("/tmp/dbx-agents.zip"),
      exportPackage: vi.fn().mockResolvedValue({ driverCount: 1 }),
      setBusy: vi.fn(),
      onSuccess: vi.fn(),
      onError: vi.fn(),
      ...overrides,
    };
  }

  it("holds the busy state across destination selection and package creation", async () => {
    const events: string[] = [];
    const options = createOptions({
      setBusy: vi.fn((busy: boolean) => events.push(`busy:${busy}`)),
      chooseDestination: vi.fn(async () => {
        events.push("choose");
        return "/tmp/dbx-agents.zip";
      }),
      exportPackage: vi.fn(async () => {
        events.push("export");
        return { driverCount: 1 };
      }),
      onSuccess: vi.fn(() => events.push("success")),
    });

    await expect(runAgentOfflineExportAction(options)).resolves.toBe("exported");
    expect(events).toEqual(["busy:true", "choose", "export", "success", "busy:false"]);
    expect(options.onError).not.toHaveBeenCalled();
  });

  it("keeps cancellation silent and always releases the busy state", async () => {
    const options = createOptions({ chooseDestination: vi.fn().mockResolvedValue(null) });

    await expect(runAgentOfflineExportAction(options)).resolves.toBe("cancelled");
    expect(options.setBusy).toHaveBeenNthCalledWith(1, true);
    expect(options.setBusy).toHaveBeenLastCalledWith(false);
    expect(options.exportPackage).not.toHaveBeenCalled();
    expect(options.onSuccess).not.toHaveBeenCalled();
    expect(options.onError).not.toHaveBeenCalled();
  });

  it.each([
    ["destination selection", { chooseDestination: vi.fn().mockRejectedValue(new Error("save failed")) }],
    ["package creation", { exportPackage: vi.fn().mockRejectedValue(new Error("export failed")) }],
  ])("reports %s failures and releases the busy state", async (_stage, overrides) => {
    const options = createOptions(overrides);

    await expect(runAgentOfflineExportAction(options)).resolves.toBe("failed");
    expect(options.setBusy).toHaveBeenNthCalledWith(1, true);
    expect(options.setBusy).toHaveBeenLastCalledWith(false);
    expect(options.onSuccess).not.toHaveBeenCalled();
    expect(options.onError).toHaveBeenCalledOnce();
  });

  it("does not enter the busy state for an empty selection", async () => {
    const options = createOptions({ driverKeys: [] });

    await expect(runAgentOfflineExportAction(options)).resolves.toBe("empty");
    expect(options.setBusy).not.toHaveBeenCalled();
    expect(options.chooseDestination).not.toHaveBeenCalled();
  });
});
