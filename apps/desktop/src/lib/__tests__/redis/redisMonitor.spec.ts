import { afterEach, describe, expect, it, vi } from "vitest";
import { REDIS_MONITOR_MAX_ROWS, startRedisMonitor } from "../../redis/redisMonitor";
import { classifyRedisCommandSafety } from "../../redis/redisCommandSafety";

function createSocket() {
  return { close: vi.fn(), onmessage: null, onerror: null, onclose: null } as unknown as WebSocket;
}

function receive(socket: WebSocket, data: object) {
  socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
}

afterEach(() => vi.useRealTimers());

describe("Redis MONITOR stream", () => {
  it("allows standalone MONITOR without permitting arbitrary commands", () => {
    expect(classifyRedisCommandSafety("monitor")).toBe("allowed");
    expect(classifyRedisCommandSafety(" MONITOR; ")).toBe("allowed");
    expect(classifyRedisCommandSafety("MONITOR extra")).toBe("blocked");
    expect(classifyRedisCommandSafety("MONITOR; FLUSHALL")).toBe("blocked");
  });
  it("streams successive batches and bounds retained rows", async () => {
    vi.useFakeTimers();
    const socket = createSocket();
    const onRows = vi.fn();
    const monitor = startRedisMonitor(async () => socket, onRows);
    await Promise.resolve();
    receive(socket, { ready: true });
    expect(onRows).toHaveBeenLastCalledWith([]);
    receive(socket, { message: "first" });
    vi.advanceTimersByTime(100);
    expect(onRows).toHaveBeenLastCalledWith(["first"]);
    for (let index = 0; index < REDIS_MONITOR_MAX_ROWS + 10; index++) receive(socket, { message: String(index) });
    vi.advanceTimersByTime(100);
    const rows = onRows.mock.lastCall![0];
    expect(rows).toHaveLength(REDIS_MONITOR_MAX_ROWS);
    expect(rows[0]).toBe("10");
    monitor.stop();
    await monitor.done;
    expect(socket.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a socket that arrives after cancellation", async () => {
    const socket = createSocket();
    let resolveConnection!: (socket: WebSocket) => void;
    const monitor = startRedisMonitor(
      () =>
        new Promise((resolve) => {
          resolveConnection = resolve;
        }),
      vi.fn(),
    );
    monitor.stop();
    resolveConnection(socket);
    await monitor.done;
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("reports server errors and cleans up", async () => {
    const socket = createSocket();
    const monitor = startRedisMonitor(async () => socket, vi.fn());
    const failure = expect(monitor.done).rejects.toThrow("NOPERM");
    await Promise.resolve();
    receive(socket, { error: "NOPERM" });
    await failure;
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("reports unexpected disconnects and ignores events after stop", async () => {
    vi.useFakeTimers();
    const socket = createSocket();
    const onRows = vi.fn();
    const monitor = startRedisMonitor(async () => socket, onRows);
    const failure = expect(monitor.done).rejects.toThrow("connection closed");
    await Promise.resolve();
    receive(socket, { ready: true });
    socket.onclose?.(new Event("close") as CloseEvent);
    await failure;
    receive(socket, { message: "late" });
    vi.advanceTimersByTime(1000);
    expect(onRows).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out setup without timing out an idle ready stream", async () => {
    vi.useFakeTimers();
    const socket = createSocket();
    const monitor = startRedisMonitor(async () => socket, vi.fn());
    await Promise.resolve();
    receive(socket, { ready: true });
    vi.advanceTimersByTime(60000);
    expect(socket.close).not.toHaveBeenCalled();
    monitor.stop();
    await monitor.done;
    const pending = startRedisMonitor(() => new Promise(() => {}), vi.fn());
    const failure = expect(pending.done).rejects.toThrow("timed out");
    vi.advanceTimersByTime(30000);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });
});
