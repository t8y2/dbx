import { describe, expect, it, vi } from "vitest";
import { isCompletionMetadataBusyError, retryCompletionMetadata } from "@/lib/metadata/completionMetadataRetry";

const BUSY = "DBX metadata pool is busy; please retry";

function noSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (delayMs: number) => {
      delays.push(delayMs);
    },
  };
}

describe("isCompletionMetadataBusyError", () => {
  it.each([BUSY, "DBX METADATA POOL IS BUSY; PLEASE RETRY", "MySQL connection pool checkout timed out [stage=wait, timeout_ms=10000]"])("recognizes the transient gate failures: %s", (message) => {
    expect(isCompletionMetadataBusyError(new Error(message))).toBe(true);
    expect(isCompletionMetadataBusyError(message)).toBe(true);
    expect(isCompletionMetadataBusyError({ message })).toBe(true);
  });

  it.each(["Connection session is not open for the requested database", "no such table: orders", "Query canceled", undefined, null])("leaves other failures alone: %s", (error) => {
    expect(isCompletionMetadataBusyError(error)).toBe(false);
  });
});

describe("retryCompletionMetadata", () => {
  it("returns the first result without sleeping", async () => {
    const { delays, sleep } = noSleep();
    const load = vi.fn().mockResolvedValue(["ID"]);

    await expect(retryCompletionMetadata(load, { kind: "columns", sleep })).resolves.toEqual(["ID"]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("retries a busy pool and returns the next result", async () => {
    const { delays, sleep } = noSleep();
    const load = vi.fn().mockRejectedValueOnce(new Error(BUSY)).mockResolvedValueOnce(["ID"]);
    const onRetry = vi.fn();

    await expect(retryCompletionMetadata(load, { kind: "columns", delaysMs: [10, 20], sleep, onRetry })).resolves.toEqual(["ID"]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([10]);
    expect(onRetry).toHaveBeenCalledWith({ kind: "columns", attempt: 1, delayMs: 10, error: BUSY });
  });

  it("gives up after the configured attempts and rethrows the last busy error", async () => {
    const { delays, sleep } = noSleep();
    const load = vi.fn().mockRejectedValue(new Error(BUSY));

    await expect(retryCompletionMetadata(load, { kind: "tables", delaysMs: [10, 20], sleep })).rejects.toThrow(BUSY);
    expect(load).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([10, 20]);
  });

  it("does not retry a failure the pool cannot recover from", async () => {
    const { delays, sleep } = noSleep();
    const load = vi.fn().mockRejectedValue(new Error("Connection session is not open for the requested database"));

    await expect(retryCompletionMetadata(load, { kind: "columns", delaysMs: [10], sleep })).rejects.toThrow("Connection session is not open");
    expect(load).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });
});
