import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { useMultiDbExecution, type MultiDbExecutionAdapter } from "@/composables/useMultiDbExecution";
import type { MultiDbTargetExecutionResult } from "@/types/sqlExecution";

const targets = [
  { connectionId: "conn-1", database: "app" },
  { connectionId: "conn-2", database: "report" },
  { connectionId: "conn-3", database: "audit" },
] as const;

describe("useMultiDbExecution", () => {
  it.each(["serial", "parallel"] as const)("tracks a single-target retry in a %s batch while preserving successful targets and manual transactions", async (mode) => {
    let release!: (result: MultiDbTargetExecutionResult) => void;
    const retryResult = new Promise<MultiDbTargetExecutionResult>((resolve) => {
      release = resolve;
    });
    const finish = vi.fn().mockResolvedValue(undefined);
    const validateTarget = vi.fn().mockResolvedValue({ valid: true });
    const executeTarget = vi.fn<MultiDbExecutionAdapter["executeTarget"]>(async ({ target }) => (target.connectionId === "conn-1" ? { status: "pending_commit", transaction: { canCommit: true, finish } } : { status: "failed", durationMs: 999, errorMessage: "original failure" }));
    const executor = useMultiDbExecution({ executeTarget, validateTarget }, { sourceTabId: "source" });
    const batch = (await executor.start("UPDATE t SET n = 1", targets.slice(0, 2), { manualTransaction: true, sourceOffset: 17 }, mode))!;
    const [successful, failed] = batch.items;
    const originalContext = executeTarget.mock.calls[1]![0].context;
    const originalStartedAt = batch.startedAt;
    executeTarget.mockImplementationOnce(() => retryResult);

    const retry = executor.retry(failed!.id);
    expect(executor.isRunning.value).toBe(true);
    expect(batch.status).toBe("running");
    expect(batch.completedAt).toBeUndefined();
    expect(batch.durationMs).toBeUndefined();
    expect(failed).toMatchObject({ status: "running", errorMessage: undefined, durationMs: undefined, completedAt: undefined });
    executor.reset();
    expect(executor.batch.value?.id).toBe(batch.id);
    expect(await executor.start("SELECT 2", targets)).toBeUndefined();
    await executor.retry(failed!.id);
    expect(await executor.finishTransaction(successful!.id, "commit")).toBe(false);
    await Promise.resolve();
    expect(executeTarget).toHaveBeenCalledTimes(3);
    expect(validateTarget).toHaveBeenLastCalledWith(targets[1]);
    expect(executeTarget.mock.calls[2]![0]).toMatchObject({ target: targets[1], sourceTabId: "source", sql: batch.sql, scopeId: batch.id });
    expect(executeTarget.mock.calls[2]![0].context).toBe(originalContext);
    expect(finish).not.toHaveBeenCalled();

    release({ status: "pending_commit", durationMs: 12, transaction: { canCommit: true, finish } });
    await retry;
    expect(batch.startedAt).toBe(originalStartedAt);
    expect(batch.status).toBe("completed");
    expect(batch.items.map((item) => item.status)).toEqual(["pending_commit", "pending_commit"]);
    expect(failed!.durationMs).toBe(12);
    await executor.retry(failed!.id);
    expect(executeTarget).toHaveBeenCalledTimes(3);
    expect(await executor.finishTransaction(failed!.id, "commit")).toBe(true);
    expect(await executor.finishTransaction(successful!.id, "rollback")).toBe(true);
    expect(finish.mock.calls.map(([action]) => action)).toEqual(["commit", "rollback"]);
    executor.reset();
    expect(executor.batch.value).toBeUndefined();
  });

  it.each(["cancelAndRollback", "dispose"] as const)("%s waits for a deferred retry and rolls back its late transaction", async (cleanup) => {
    let release!: (result: MultiDbTargetExecutionResult) => void;
    const retryResult = new Promise<MultiDbTargetExecutionResult>((resolve) => {
      release = resolve;
    });
    const finish = vi.fn().mockResolvedValue(undefined);
    const executeTarget = vi
      .fn<MultiDbExecutionAdapter["executeTarget"]>()
      .mockResolvedValueOnce({ status: "failed" })
      .mockImplementationOnce(() => retryResult);
    const cancelPending = vi.fn().mockRejectedValue(new Error("confirmation already closed"));
    const cancelTarget = vi.fn().mockRejectedValue(new Error("cancel unavailable"));
    const executor = useMultiDbExecution({ executeTarget, cancelPending, cancelTarget }, { sourceTabId: "source" });
    const batch = (await executor.start("UPDATE t SET n = 1", [targets[0]], { manualTransaction: true }))!;
    const retry = executor.retry(batch.items[0]!.id);
    const isCancellationRequested = executeTarget.mock.calls[1]![0].isCancellationRequested;
    expect(isCancellationRequested()).toBe(false);
    let cleaned = false;
    const cleaning = executor[cleanup]().then((result) => {
      cleaned = true;
      return result;
    });
    await vi.waitFor(() => expect(cancelTarget).toHaveBeenCalledExactlyOnceWith("source", batch.id));
    expect(cancelPending).toHaveBeenCalledExactlyOnceWith(batch.id);
    expect(isCancellationRequested()).toBe(true);
    expect(batch.status).toBe("cancelling");
    executor.reset();
    expect(executor.batch.value?.id).toBe(batch.id);
    expect(await executor.start("SELECT 2", targets)).toBeUndefined();
    expect(cleaned).toBe(false);
    expect(finish).not.toHaveBeenCalled();

    release({ status: "pending_commit", transaction: { canCommit: true, finish } });
    await retry;
    expect(await cleaning).toBe(true);
    expect(finish).toHaveBeenCalledExactlyOnceWith("rollback");
    expect(batch.status).toBe("cancelled");
    expect(batch.items[0]!.status).toBe("rolled_back");
    expect(executor.hasTransactions.value).toBe(false);
    if (cleanup === "dispose") {
      await executor.retry(batch.items[0]!.id);
      expect(await executor.start("SELECT 2", targets)).toBeUndefined();
      expect(executeTarget).toHaveBeenCalledTimes(2);
    }
  });

  it("retains a retry transaction when disposal cannot roll it back", async () => {
    let release!: (result: MultiDbTargetExecutionResult) => void;
    const retryResult = new Promise<MultiDbTargetExecutionResult>((resolve) => {
      release = resolve;
    });
    const finish = vi.fn().mockRejectedValue(new Error("rollback unavailable"));
    const executeTarget = vi
      .fn<MultiDbExecutionAdapter["executeTarget"]>()
      .mockResolvedValueOnce({ status: "failed" })
      .mockImplementationOnce(() => retryResult);
    const executor = useMultiDbExecution({ executeTarget }, { sourceTabId: "source" });
    const batch = (await executor.start("UPDATE t SET n = 1", [targets[0]], { manualTransaction: true }))!;
    const retry = executor.retry(batch.items[0]!.id);
    const disposing = executor.dispose();
    release({ status: "failed", transaction: { canCommit: false, finish } });
    await retry;
    expect(await disposing).toBe(false);
    expect(batch.items[0]!.errorMessage).toBe("rollback unavailable");
    expect(executor.hasTransactions.value).toBe(true);
    executor.reset();
    expect(executor.batch.value?.id).toBe(batch.id);
    await executor.retry(batch.items[0]!.id);
    expect(executeTarget).toHaveBeenCalledTimes(2);
    expect(await executor.finishTransaction(batch.items[0]!.id, "commit")).toBe(false);
    finish.mockResolvedValue(undefined);
    expect(await executor.rollbackPending()).toBe(true);
  });

  it("clears cancellation when retrying one target without executing the cancelled queue", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executeTarget = vi.fn<MultiDbExecutionAdapter["executeTarget"]>(async () => {
      await gate;
      return { status: "failed" };
    });
    const executor = useMultiDbExecution({ executeTarget }, { sourceTabId: "source" });
    const run = executor.start("SELECT 1", targets);
    await executor.cancel();
    release();
    const batch = (await run)!;
    expect(batch.status).toBe("cancelled");
    executeTarget.mockImplementationOnce(async ({ isCancellationRequested }) => {
      expect(isCancellationRequested()).toBe(false);
      return { status: "success" };
    });
    await executor.retry(batch.items[0]!.id);
    expect(batch.cancelRequested).toBe(false);
    expect(batch.status).toBe("completed");
    expect(batch.items.map((item) => item.status)).toEqual(["success", "not_executed", "not_executed"]);
    await executor.retry(batch.items[0]!.id);
    await executor.retry("missing");
    expect(executeTarget).toHaveBeenCalledTimes(2);
  });

  it.each(["invalid", "throws", "cancelled"] as const)("revalidates retries and does not execute when validation is %s", async (outcome) => {
    let release!: (result: { valid: boolean; errorMessage?: string }) => void;
    const validation = new Promise<{ valid: boolean; errorMessage?: string }>((resolve) => {
      release = resolve;
    });
    const validateTarget = vi.fn().mockResolvedValueOnce({ valid: true });
    const executeTarget = vi.fn<MultiDbExecutionAdapter["executeTarget"]>().mockResolvedValue({ status: "failed", durationMs: 999, errorMessage: "old failure" });
    const executor = useMultiDbExecution({ executeTarget, validateTarget }, { sourceTabId: "source" });
    const batch = (await executor.start("SELECT 1", [targets[0]]))!;
    if (outcome === "throws") validateTarget.mockRejectedValueOnce(new Error("validation unavailable"));
    else validateTarget.mockImplementationOnce(() => validation);
    const retry = executor.retry(batch.items[0]!.id);
    if (outcome === "cancelled") await executor.cancel();
    release({ valid: outcome === "cancelled", errorMessage: "target unavailable" });
    await retry;
    expect(executeTarget).toHaveBeenCalledTimes(1);
    expect(validateTarget).toHaveBeenCalledTimes(2);
    expect(batch.items[0]!.status).toBe(outcome === "cancelled" ? "cancelled" : "failed");
    expect(batch.items[0]!.durationMs).not.toBe(999);
    expect(batch.items[0]!.errorMessage).toBe(outcome === "throws" ? "validation unavailable" : outcome === "invalid" ? "target unavailable" : undefined);
    expect(executor.isRunning.value).toBe(false);
    executor.reset();
    expect(executor.batch.value).toBeUndefined();
  });

  it("retains separate transactions until each target is explicitly settled", async () => {
    const commits = targets.map(() => vi.fn().mockResolvedValue(undefined));
    const executor = useMultiDbExecution(
      {
        executeTarget: async ({ target, context }) => {
          expect(context.manualTransaction).toBe(true);
          return { status: "pending_commit", transaction: { canCommit: true, finish: commits[targets.findIndex((candidate) => candidate.connectionId === target.connectionId)] } };
        },
      },
      { sourceTabId: "source" },
    );
    const batch = await executor.start("UPDATE t SET n = 1", targets, { manualTransaction: true });
    expect(executor.hasTransactions.value).toBe(true);
    expect(commits.every((commit) => commit.mock.calls.length === 0)).toBe(true);
    executor.reset();
    expect(executor.batch.value?.id).toBe(batch?.id);
    expect(await executor.start("SELECT 2", targets)).toBeUndefined();
    await executor.finishTransaction(batch!.items[0].id, "commit");
    await executor.finishTransaction(batch!.items[1].id, "rollback");
    expect(batch!.items.map((item) => item.status)).toEqual(["success", "rolled_back", "pending_commit"]);
    expect(commits[0]).toHaveBeenCalledWith("commit");
    expect(commits[1]).toHaveBeenCalledWith("rollback");
    expect(commits[2]).not.toHaveBeenCalled();
  });

  it("preserves a failed settlement for rollback and does not run it twice concurrently", async () => {
    let reject!: (reason: Error) => void;
    const finish = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const executor = useMultiDbExecution({ executeTarget: async () => ({ status: "pending_commit", transaction: { canCommit: true, finish } }) }, { sourceTabId: "source" });
    const batch = await executor.start("UPDATE t SET n = 1", [targets[0]], { manualTransaction: true });
    const committing = executor.finishTransaction(batch!.items[0].id, "commit");
    expect(await executor.finishTransaction(batch!.items[0].id, "commit")).toBe(false);
    reject(new Error("connection lost"));
    expect(await committing).toBe(false);
    expect(batch!.items[0].errorMessage).toBe("connection lost");
    expect(executor.hasTransactions.value).toBe(true);
    finish.mockResolvedValueOnce(undefined);
    expect(await executor.finishTransaction(batch!.items[0].id, "rollback")).toBe(true);
    expect(finish).toHaveBeenCalledTimes(2);
    expect(executor.hasTransactions.value).toBe(false);
  });

  it("rolls back an execution that finishes after disposal without starting the next target", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finish = vi.fn().mockResolvedValue(undefined);
    const executeTarget = vi.fn(async () => {
      await gate;
      return { status: "pending_commit" as const, transaction: { canCommit: true, finish } };
    });
    const executor = useMultiDbExecution({ executeTarget }, { sourceTabId: "source" });
    const run = executor.start("UPDATE t SET n = 1", targets, { manualTransaction: true });
    const disposing = executor.dispose();
    expect(finish).not.toHaveBeenCalled();
    release();
    await run;
    expect(await disposing).toBe(true);
    expect(executeTarget).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledExactlyOnceWith("rollback");
    expect(executor.batch.value!.items.map((item) => item.status)).toEqual(["rolled_back", "not_executed", "not_executed"]);
  });

  it("waits for a commit in flight before disposing the other transactions", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finish = vi.fn(async (action: string) => {
      if (action === "commit") await gate;
    });
    const executor = useMultiDbExecution({ executeTarget: async () => ({ status: "pending_commit", transaction: { canCommit: true, finish } }) }, { sourceTabId: "source" });
    const batch = await executor.start("UPDATE t SET n = 1", targets.slice(0, 2), { manualTransaction: true });
    const commit = executor.finishTransaction(batch!.items[0].id, "commit");
    const disposing = executor.dispose();
    release();
    await commit;
    expect(await disposing).toBe(true);
    expect(batch!.items.map((item) => item.status)).toEqual(["success", "rolled_back"]);
    expect(finish.mock.calls.map((call) => call[0])).toEqual(["commit", "rollback"]);
  });

  it("retains failed cleanup without allowing commit or reset", async () => {
    const finish = vi.fn().mockRejectedValue(new Error("rollback unavailable"));
    const executor = useMultiDbExecution({ executeTarget: async () => ({ status: "failed", transaction: { canCommit: false, finish } }) }, { sourceTabId: "source" });
    const batch = await executor.start("UPDATE t SET n = 1", [targets[0]], { manualTransaction: true });
    expect(await executor.finishTransaction(batch!.items[0].id, "commit")).toBe(false);
    expect(finish).not.toHaveBeenCalled();
    expect(await executor.rollbackPending()).toBe(false);
    executor.reset();
    expect(executor.hasTransactions.value).toBe(true);
    expect(batch!.items[0].errorMessage).toBe("rollback unavailable");
  });

  it("reports an unknown commit outcome instead of marking it rolled back", async () => {
    const finish = vi.fn().mockResolvedValue("Verify data: commit result unknown");
    const executor = useMultiDbExecution({ executeTarget: async () => ({ status: "pending_commit", transaction: { canCommit: false, finish } }) }, { sourceTabId: "source" });
    const batch = await executor.start("UPDATE t SET n = 1", [targets[0]], { manualTransaction: true });
    expect(await executor.finishTransaction(batch!.items[0].id, "rollback")).toBe(false);
    expect(batch!.items[0].status).toBe("failed");
    expect(batch!.items[0].errorMessage).toBe("Verify data: commit result unknown");
    expect(executor.hasTransactions.value).toBe(false);
  });

  it("executes serially and continues after a target failure", async () => {
    const executionOrder: string[] = [];
    const executor = useMultiDbExecution(
      {
        executeTarget: async ({ target }) => {
          executionOrder.push(target.connectionId);
          return target.connectionId === "conn-1" ? { status: "failed", errorMessage: "boom" } : { status: "success" };
        },
      },
      { sourceTabId: ref("source") },
    );

    const batch = await executor.start("ALTER TABLE users ADD COLUMN active BOOLEAN", targets);

    expect(executionOrder).toEqual(["conn-1", "conn-2", "conn-3"]);
    expect(batch?.items.map((item) => item.status)).toEqual(["failed", "success", "success"]);
    expect(batch?.status).toBe("completed");
  });

  it("executes all targets concurrently in parallel mode", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const executor = useMultiDbExecution(
      {
        executeTarget: async ({ target }) => {
          started.push(target.connectionId);
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          await gate;
          running -= 1;
          return { status: "success" as const, durationMs: 12 };
        },
      },
      { sourceTabId: "source" },
    );

    const run = executor.start("UPDATE users SET active = TRUE", targets, {}, "parallel");
    await Promise.resolve();

    expect(started).toEqual(["conn-1", "conn-2", "conn-3"]);
    expect(maxRunning).toBe(3);

    release();
    const batch = await run;
    expect(batch?.mode).toBe("parallel");
    expect(batch?.items.map((item) => item.status)).toEqual(["success", "success", "success"]);
    expect(batch?.items.every((item) => item.durationMs === 12)).toBe(true);
    expect(batch?.durationMs).toEqual(expect.any(Number));
  });

  it("takes a target snapshot before execution starts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = useMultiDbExecution(
      {
        executeTarget: async () => {
          await gate;
          return { status: "success" };
        },
      },
      { sourceTabId: "source" },
    );
    const mutableTargets = targets.map((target) => ({ ...target }));
    const run = executor.start("SELECT 1", mutableTargets);
    await Promise.resolve();

    mutableTargets[0].database = "changed-after-confirmation";
    expect(executor.batch.value?.items[0].target.database).toBe("app");

    release();
    await run;
  });

  it("keeps the source offset in the immutable batch context", async () => {
    let receivedOffset: number | undefined;
    const executor = useMultiDbExecution(
      {
        executeTarget: async ({ context }) => {
          receivedOffset = context.sourceOffset;
          return { status: "success" };
        },
      },
      { sourceTabId: "source" },
    );

    await executor.start("SELECT 1", [targets[0]], { sourceOffset: 17 });

    expect(receivedOffset).toBe(17);
    expect(Object.isFrozen(executor.batch.value?.context)).toBe(true);
  });

  it("cancels the current target and marks remaining targets as not executed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancelTarget = vi.fn(async () => {
      release();
    });
    const executor = useMultiDbExecution(
      {
        executeTarget: async () => {
          await gate;
          return { status: "cancelled" };
        },
        cancelTarget,
      },
      { sourceTabId: "source" },
    );

    const run = executor.start("DROP TABLE users", targets);
    await Promise.resolve();
    await executor.cancel();
    await run;

    expect(cancelTarget).toHaveBeenCalledWith("source", expect.any(String));
    expect(executor.batch.value?.items.map((item) => item.status)).toEqual(["cancelled", "not_executed", "not_executed"]);
    expect(executor.batch.value?.status).toBe("cancelled");
  });

  it("enters cancelling before waiting for the current target to settle", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = useMultiDbExecution(
      {
        executeTarget: async () => {
          await gate;
          return { status: "cancelled" };
        },
        cancelTarget: async () => release(),
      },
      { sourceTabId: "source" },
    );

    const run = executor.start("DROP TABLE users", targets);
    await Promise.resolve();
    const cancel = executor.cancel();
    expect(executor.batch.value?.status).toBe("cancelling");
    await cancel;
    await run;
    expect(executor.batch.value?.status).toBe("cancelled");
  });

  it("does not create a target tab when cancellation arrives during validation", async () => {
    let releaseValidation!: () => void;
    const validationFinished = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const executor = useMultiDbExecution(
      {
        validateTarget: async () => {
          await validationFinished;
          return { valid: true };
        },
        executeTarget: async () => ({ status: "success" as const }),
      },
      { sourceTabId: "source" },
    );

    const run = executor.start("ALTER TABLE users ADD COLUMN active BOOLEAN", targets);
    await Promise.resolve();
    await executor.cancel();
    releaseValidation();
    await run;

    expect(executor.batch.value?.items.map((item) => item.status)).toEqual(["cancelled", "not_executed", "not_executed"]);
  });
});
