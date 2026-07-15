import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelPendingSidebarDataOpen, runSidebarDataOpenImmediately } from "@/lib/sidebar/sidebarDataOpenCoordinator";

describe("sidebarDataOpenCoordinator", () => {
  afterEach(() => {
    cancelPendingSidebarDataOpen();
  });

  it("cancels the active request when a newer open starts", async () => {
    const cancel = vi.fn();
    let firstIsCurrent = true;

    runSidebarDataOpenImmediately(async (request) => {
      request.registerCancel(cancel);
      await Promise.resolve();
      firstIsCurrent = request.isCurrent();
    });
    runSidebarDataOpenImmediately(() => undefined);
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledOnce();
    expect(firstIsCurrent).toBe(false);
  });

  it("runs registered cancellation immediately for an already stale request", async () => {
    const cancel = vi.fn();
    let registerLateCancel: (() => void) | undefined;

    runSidebarDataOpenImmediately((request) => {
      registerLateCancel = () => request.registerCancel(cancel);
    });
    runSidebarDataOpenImmediately(() => undefined);
    registerLateCancel?.();
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("recovers after a runner throws synchronously", async () => {
    const nextRunner = vi.fn();

    runSidebarDataOpenImmediately(() => {
      throw new Error("boom");
    });
    await Promise.resolve();
    runSidebarDataOpenImmediately(nextRunner);
    await Promise.resolve();

    expect(nextRunner).toHaveBeenCalledOnce();
  });

  it("keeps only the newest rapid navigation request current", async () => {
    const states: boolean[] = [];
    const captures: Array<() => void> = [];

    for (let index = 0; index < 3; index += 1) {
      runSidebarDataOpenImmediately((request) => {
        captures.push(() => states.push(request.isCurrent()));
      });
    }
    captures.forEach((capture) => capture());

    expect(states).toEqual([false, false, true]);
  });

  it("does not cancel work that was not registered as sidebar-owned", async () => {
    const sidebarCancel = vi.fn();
    const unrelatedEditorCancel = vi.fn();

    runSidebarDataOpenImmediately((request) => request.registerCancel(sidebarCancel));
    runSidebarDataOpenImmediately(() => undefined);
    await Promise.resolve();

    expect(sidebarCancel).toHaveBeenCalledOnce();
    expect(unrelatedEditorCancel).not.toHaveBeenCalled();
  });

  it("prevents a superseded connection completion from becoming current", async () => {
    let finishConnection: (() => void) | undefined;
    let completionWasCurrent = true;

    runSidebarDataOpenImmediately(async (request) => {
      await new Promise<void>((resolve) => {
        finishConnection = resolve;
      });
      completionWasCurrent = request.isCurrent();
    });
    runSidebarDataOpenImmediately(() => undefined);
    finishConnection?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(completionWasCurrent).toBe(false);
  });
});
