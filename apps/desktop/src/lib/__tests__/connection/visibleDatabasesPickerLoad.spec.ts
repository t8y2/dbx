import { afterEach, describe, expect, it, vi } from "vitest";
import { loadVisibleDatabasesPickerNames } from "@/lib/connection/visibleDatabasesPickerLoad";

describe("loadVisibleDatabasesPickerNames", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the listed names and always releases the draft connection", async () => {
    const disconnect = vi.fn(async () => {});

    const names = await loadVisibleDatabasesPickerNames({
      connect: vi.fn(async () => {}),
      listNames: vi.fn(async () => ["0", "1", "2"]),
      disconnect,
      queryTimeoutSecs: 10,
    });

    expect(names).toEqual(["0", "1", "2"]);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps the listed names when releasing the draft fails", async () => {
    const disconnect = vi.fn(async () => {
      throw new Error("Redis connection failed: connection reset");
    });

    await expect(
      loadVisibleDatabasesPickerNames({
        connect: vi.fn(async () => {}),
        listNames: vi.fn(async () => ["0"]),
        disconnect,
        queryTimeoutSecs: 10,
      }),
    ).resolves.toEqual(["0"]);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  // #12426：服务端接受了连接探测，但 CONFIG/INFO 一直不回答时，选择器必须结束等待。
  it("stops waiting and reports a timeout when the list request never answers", async () => {
    vi.useFakeTimers();
    const disconnect = vi.fn(async () => {});
    const pending = loadVisibleDatabasesPickerNames({
      connect: vi.fn(async () => {}),
      listNames: () => new Promise<string[]>(() => {}),
      disconnect,
    });
    const assertion = expect(pending).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(40_000);
    await assertion;
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("bounds the draft connect step too", async () => {
    vi.useFakeTimers();
    const listNames = vi.fn(async () => ["0"]);
    const pending = loadVisibleDatabasesPickerNames({
      connect: () => new Promise<void>(() => {}),
      listNames,
      disconnect: vi.fn(async () => {}),
      queryTimeoutSecs: 0,
    });
    const assertion = expect(pending).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(61_000);
    await assertion;
    expect(listNames).not.toHaveBeenCalled();
  });
});
