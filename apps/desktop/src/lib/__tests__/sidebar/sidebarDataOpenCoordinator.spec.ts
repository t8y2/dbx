import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelPendingSidebarDataOpen, runSidebarDataOpenImmediately, supersedeSidebarDataNavigation } from "@/lib/sidebar/sidebarDataOpenCoordinator";

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

  it("cancels queued ordinary navigation for another target but preserves the same target and new-tab", async () => {
    const blockedOther = deferred();
    const blockedSame = deferred();
    const blockedNewTab = deferred();
    const queuedOtherTarget = vi.fn();
    const queuedSameTarget = vi.fn();
    const newTab = vi.fn();

    runSidebarDataOpenImmediately({ connectionKey: "other-conn", supersede: false }, () => blockedOther.promise);
    runSidebarDataOpenImmediately({ connectionKey: "other-conn", targetKey: "other" }, queuedOtherTarget);
    runSidebarDataOpenImmediately({ connectionKey: "same-conn", supersede: false }, () => blockedSame.promise);
    runSidebarDataOpenImmediately({ connectionKey: "same-conn", targetKey: "target" }, queuedSameTarget);
    runSidebarDataOpenImmediately({ connectionKey: "new-tab-conn", supersede: false }, () => blockedNewTab.promise);
    runSidebarDataOpenImmediately({ connectionKey: "new-tab-conn", supersede: false }, newTab);

    supersedeSidebarDataNavigation("target");

    expect(queuedOtherTarget).not.toHaveBeenCalled();
    expect(queuedSameTarget).not.toHaveBeenCalled();
    expect(newTab).not.toHaveBeenCalled();

    blockedOther.resolve();
    blockedSame.resolve();
    blockedNewTab.resolve();
    await vi.waitFor(() => expect(queuedSameTarget).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(newTab).toHaveBeenCalledOnce());
    expect(queuedOtherTarget).not.toHaveBeenCalled();
  });

  it("cancels an active ordinary navigation for another target", async () => {
    const active = deferred();
    const activeCancel = vi.fn();
    let activeRequest: { isCurrent: () => boolean; signal: AbortSignal } | undefined;

    runSidebarDataOpenImmediately({ connectionKey: "conn", targetKey: "other" }, (request) => {
      activeRequest = request;
      request.registerCancel(activeCancel);
      return active.promise;
    });

    supersedeSidebarDataNavigation("target");

    expect(activeCancel).toHaveBeenCalledOnce();
    expect(activeRequest?.signal.aborted).toBe(true);
    active.resolve();
  });

  it("preserves active ordinary navigation for the clicked target", async () => {
    const active = deferred();
    const activeCancel = vi.fn();
    let activeRequest: { isCurrent: () => boolean; signal: AbortSignal } | undefined;

    runSidebarDataOpenImmediately({ connectionKey: "conn", targetKey: "target" }, (request) => {
      activeRequest = request;
      request.registerCancel(activeCancel);
      return active.promise;
    });

    supersedeSidebarDataNavigation("target");

    expect(activeCancel).not.toHaveBeenCalled();
    expect(activeRequest?.signal.aborted).toBe(false);
    expect(activeRequest?.isCurrent()).toBe(true);
    active.resolve();
    await vi.waitFor(() => expect(activeRequest?.isCurrent()).toBe(false));
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

  it("marks a completed request non-current without aborting its signal", async () => {
    let requestState: { isCurrent: () => boolean; signal: AbortSignal } | undefined;

    runSidebarDataOpenImmediately({ connectionKey: "conn" }, (request) => {
      requestState = request;
    });

    await vi.waitFor(() => expect(requestState?.isCurrent()).toBe(false));
    expect(requestState?.signal.aborted).toBe(false);
  });
});
