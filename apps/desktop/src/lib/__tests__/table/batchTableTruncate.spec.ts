import { describe, expect, it, vi } from "vitest";
import { runBatchTableTruncate } from "@/lib/table/batchTableTruncate";

describe("batch table truncate", () => {
  it("refreshes completed targets before propagating a later failure", async () => {
    const execute = vi.fn(async (table: string) => {
      if (table === "locked") throw new Error("permission denied");
    });
    const refreshSucceeded = vi.fn(async () => undefined);

    await expect(runBatchTableTruncate(["orders", "locked", "customers"], execute, refreshSucceeded)).rejects.toThrow("permission denied");

    expect(execute).toHaveBeenCalledTimes(2);
    expect(refreshSucceeded).toHaveBeenCalledOnce();
    expect(refreshSucceeded).toHaveBeenCalledWith(["orders"]);
  });

  it("does not refresh when the first target fails", async () => {
    const refreshSucceeded = vi.fn(async () => undefined);

    await expect(
      runBatchTableTruncate(
        ["locked"],
        async () => {
          throw new Error("permission denied");
        },
        refreshSucceeded,
      ),
    ).rejects.toThrow("permission denied");

    expect(refreshSucceeded).not.toHaveBeenCalled();
  });
});
