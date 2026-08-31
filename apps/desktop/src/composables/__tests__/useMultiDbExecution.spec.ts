import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { useMultiDbExecution } from "@/composables/useMultiDbExecution";

const targets = [
  { connectionId: "conn-1", database: "app" },
  { connectionId: "conn-2", database: "report" },
  { connectionId: "conn-3", database: "audit" },
] as const;

describe("useMultiDbExecution", () => {
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
