import { describe, expect, it, vi } from "vitest";
import { releaseEtcdWatch, releaseEtcdWatchBestEffort, releaseEtcdWatchesBestEffort, replaceEtcdWatch } from "@/lib/etcd/watchLifecycle";

describe("etcd watch lifecycle", () => {
  it("releases terminal and stopped watch ids without consulting UI status", async () => {
    const stop = vi.fn().mockResolvedValue({ stopped: true });

    await releaseEtcdWatch("etcd-1", "terminal-watch", stop);
    await releaseEtcdWatch("etcd-1", "stopped-watch", stop);

    expect(stop.mock.calls).toEqual([
      ["etcd-1", "terminal-watch"],
      ["etcd-1", "stopped-watch"],
    ]);
  });

  it("stops the previous id before starting a replacement", async () => {
    const order: string[] = [];
    const stop = vi.fn(async (_connectionId: string, watchId: string) => {
      order.push(`stop:${watchId}`);
    });

    const result = await replaceEtcdWatch("etcd-1", "old-watch", stop, async () => {
      order.push("start");
      return "new-watch";
    });

    expect(result).toBe("new-watch");
    expect(order).toEqual(["stop:old-watch", "start"]);
  });

  it("releases every retained id during best-effort teardown", async () => {
    const stop = vi.fn().mockResolvedValue({ stopped: true });

    await releaseEtcdWatchesBestEffort("etcd-1", ["running", "terminal", "stopped", ""], stop);

    expect(stop.mock.calls.map((call) => call[1]).sort()).toEqual(["running", "stopped", "terminal"]);
  });

  it("propagates a stop failure and does not start a replacement", async () => {
    const stopError = new Error("stop timed out");
    const stop = vi.fn().mockRejectedValue(stopError);
    const start = vi.fn().mockResolvedValue("new-watch");

    await expect(releaseEtcdWatch("etcd-1", "old-watch", stop)).rejects.toBe(stopError);
    await expect(replaceEtcdWatch("etcd-1", "old-watch", stop, start)).rejects.toBe(stopError);

    expect(start).not.toHaveBeenCalled();
  });

  it("suppresses stop failures only for best-effort cleanup", async () => {
    const stop = vi.fn().mockRejectedValue(new Error("runtime unavailable"));

    await expect(releaseEtcdWatchBestEffort("etcd-1", "old-watch", stop)).resolves.toBeUndefined();
    await expect(releaseEtcdWatchesBestEffort("etcd-1", ["first", "second"], stop)).resolves.toBeUndefined();

    expect(stop).toHaveBeenCalledTimes(3);
  });

  it("does not accumulate slots across repeated terminal cycles", async () => {
    const active = new Set<string>();
    const stop = vi.fn(async (_connectionId: string, watchId: string) => {
      active.delete(watchId);
    });

    for (let index = 0; index < 4; index++) {
      const watchId = `watch-${index}`;
      active.add(watchId);
      await releaseEtcdWatch("etcd-1", watchId, stop);
    }

    expect(active.size).toBe(0);
    active.add("watch-next");
    expect(active.size).toBe(1);
  });
});
