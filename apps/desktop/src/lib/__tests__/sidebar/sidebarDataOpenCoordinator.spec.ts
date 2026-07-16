import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelPendingSidebarDataOpen, runSidebarDataOpenImmediately } from "@/lib/sidebar/sidebarDataOpenCoordinator";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("sidebarDataOpenCoordinator", () => {
  afterEach(() => {
    cancelPendingSidebarDataOpen();
  });

  it("cancels the active request when a newer ordinary open starts", async () => {
    const cancel = vi.fn();
    const running = deferred();
    let firstIsCurrent = true;

    runSidebarDataOpenImmediately({ connectionKey: "conn" }, async (request) => {
      request.registerCancel(cancel);
      await running.promise;
      firstIsCurrent = request.isCurrent();
    });
    runSidebarDataOpenImmediately({ connectionKey: "conn" }, () => undefined);
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledOnce();
    expect(firstIsCurrent).toBe(true);

    running.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(firstIsCurrent).toBe(false);
  });

  it("replaces a superseded queued request before it starts", async () => {
    const running = deferred();
    const second = vi.fn();
    const third = vi.fn();

    runSidebarDataOpenImmediately({ connectionKey: "conn", supersede: false }, () => running.promise);
    runSidebarDataOpenImmediately({ connectionKey: "conn" }, second);
    runSidebarDataOpenImmediately({ connectionKey: "conn" }, third);
    running.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(second).not.toHaveBeenCalled();
    expect(third).toHaveBeenCalledOnce();
  });

  it("bounds active work per connection", async () => {
    const first = deferred();
    const starts: string[] = [];

    runSidebarDataOpenImmediately({ connectionKey: "conn", supersede: false }, async () => {
      starts.push("first");
      await first.promise;
    });
    runSidebarDataOpenImmediately({ connectionKey: "conn", supersede: false }, () => {
      starts.push("second");
    });

    expect(starts).toEqual(["first"]);
    first.resolve();
    await vi.waitFor(() => expect(starts).toEqual(["first", "second"]));
  });

  it("allows different connections to make progress independently", () => {
    const blocked = deferred();
    const otherConnection = vi.fn();

    runSidebarDataOpenImmediately({ connectionKey: "conn-a", supersede: false }, () => blocked.promise);
    runSidebarDataOpenImmediately({ connectionKey: "conn-b", supersede: false }, otherConnection);

    expect(otherConnection).toHaveBeenCalledOnce();
    blocked.resolve();
  });

  it("keeps explicit new-tab opens independent while still queueing them", async () => {
    const first = deferred();
    const firstCancel = vi.fn();
    const second = vi.fn();

    runSidebarDataOpenImmediately({ connectionKey: "conn", supersede: false }, async (request) => {
      request.registerCancel(firstCancel);
      await first.promise;
    });
    runSidebarDataOpenImmediately({ connectionKey: "conn", supersede: false }, second);

    expect(firstCancel).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    first.resolve();
    await vi.waitFor(() => expect(second).toHaveBeenCalledOnce());
  });

  it("runs registered cancellation immediately for an already stale request", async () => {
    const cancel = vi.fn();
    let registerLateCancel: (() => void) | undefined;
    const running = deferred();

    runSidebarDataOpenImmediately({ connectionKey: "conn" }, async (request) => {
      registerLateCancel = () => request.registerCancel(cancel);
      await running.promise;
    });
    runSidebarDataOpenImmediately({ connectionKey: "conn" }, () => undefined);
    registerLateCancel?.();
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledOnce();
    running.resolve();
  });

  it("recovers after a runner throws synchronously", async () => {
    const nextRunner = vi.fn();

    runSidebarDataOpenImmediately({ connectionKey: "conn", supersede: false }, () => {
      throw new Error("boom");
    });
    await Promise.resolve();
    await Promise.resolve();
    runSidebarDataOpenImmediately({ connectionKey: "conn", supersede: false }, nextRunner);

    expect(nextRunner).toHaveBeenCalledOnce();
  });

  it("aborts a superseded request signal", () => {
    let signal: AbortSignal | undefined;

    runSidebarDataOpenImmediately({ connectionKey: "conn" }, (request) => {
      signal = request.signal;
    });
    runSidebarDataOpenImmediately({ connectionKey: "conn" }, () => undefined);

    expect(signal?.aborted).toBe(true);
  });
});
