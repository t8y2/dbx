import { describe, expect, it } from "vitest";
import { batchTableEmptyFeedback, buildBatchTableEmptyPlan, runBatchTableEmpty, runBatchTableEmptyLayers } from "@/lib/sidebar/batchTableEmpty";

describe("batch table empty", () => {
  it("executes the exact SQL captured for the confirmation preview", async () => {
    const targets = [{ name: "orders" }, { name: "customers" }];
    let schema = "public";
    const plan = await buildBatchTableEmptyPlan(targets, async (target) => `TRUNCATE TABLE "${schema}"."${target.name}";`);
    schema = "archive";

    const executed: string[] = [];
    await runBatchTableEmpty(plan, async ({ sql }) => {
      executed.push(sql);
    });

    expect(plan.map(({ sql }) => sql).join("\n")).toBe('TRUNCATE TABLE "public"."orders";\nTRUNCATE TABLE "public"."customers";');
    expect(executed).toEqual(['TRUNCATE TABLE "public"."orders";', 'TRUNCATE TABLE "public"."customers";']);
  });

  it("rejects the entire destructive plan when any preview SQL is unavailable", async () => {
    await expect(buildBatchTableEmptyPlan(["orders", "customers"], async (target) => (target === "customers" ? "" : `TRUNCATE TABLE ${target};`))).rejects.toThrow("Empty table SQL preview is unavailable");
  });

  it("continues after a table fails and collects each result", async () => {
    const executed: string[] = [];
    const result = await runBatchTableEmpty(["orders", "locked", "customers"], async (table) => {
      executed.push(table);
      if (table === "locked") throw new Error("permission denied");
    });

    expect(executed).toEqual(["orders", "locked", "customers"]);
    expect(result.succeeded).toEqual(["orders", "customers"]);
    expect(result.failed.map(({ target }) => target)).toEqual(["locked"]);
  });

  it("uses submitted feedback for asynchronous mutations", () => {
    const succeeded = { succeeded: ["events"], failed: [] };
    const partial = { succeeded: ["events"], failed: [{ target: "logs", error: new Error("failed") }] };
    const failed = { succeeded: [], failed: [{ target: "logs", error: new Error("failed") }] };
    const skipped = { succeeded: ["events"], failed: [], skipped: [{ target: "logs", reason: "blocked" }] };
    const cancelled = { succeeded: ["events"], failed: [], cancelled: ["logs"] };

    expect(batchTableEmptyFeedback(succeeded, true)).toBe("submitted");
    expect(batchTableEmptyFeedback(partial, true)).toBe("submitted-partial");
    expect(batchTableEmptyFeedback(failed, true)).toBe("submitted-partial");
    expect(batchTableEmptyFeedback(succeeded, false)).toBe("success");
    expect(batchTableEmptyFeedback(partial, false)).toBe("partial");
    expect(batchTableEmptyFeedback(failed, false)).toBe("partial");
    expect(batchTableEmptyFeedback(skipped, false)).toBe("partial");
    expect(batchTableEmptyFeedback(cancelled, true)).toBe("submitted-partial");
  });

  it("limits independent table execution concurrency", async () => {
    let active = 0;
    let peak = 0;
    const result = await runBatchTableEmptyLayers([{ items: Array.from({ length: 40 }, (_, i) => ({ target: i, sql: `DELETE ${i}` })) }], {
      concurrency: 8,
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
      },
    });
    expect(peak).toBeLessThanOrEqual(8);
    expect(result.succeeded).toHaveLength(40);
  });

  it("stops dispatching after cancellation", async () => {
    let dispatched = 0;
    let cancelled = false;
    const result = await runBatchTableEmptyLayers([{ items: Array.from({ length: 20 }, (_, i) => ({ target: i, sql: `DELETE ${i}` })) }], {
      concurrency: 4,
      isCancelled: () => cancelled,
      execute: async () => {
        dispatched += 1;
        cancelled = true;
      },
    });
    expect(dispatched).toBe(1);
    expect(result.cancelled?.length).toBe(19);
  });

  it("classifies an in-flight cancellation separately from a failure", async () => {
    let cancelled = false;
    const result = await runBatchTableEmptyLayers([{ items: [{ target: "orders", sql: "DELETE FROM orders" }] }], {
      isCancelled: () => cancelled,
      execute: async () => {
        cancelled = true;
        throw new Error("request aborted");
      },
    });

    expect(result.failed).toHaveLength(0);
    expect(result.cancelled).toEqual(["orders"]);
  });

  it("skips a parent after a child in an earlier layer fails", async () => {
    const executed: string[] = [];
    const result = await runBatchTableEmptyLayers([{ items: [{ target: "child", sql: "DELETE FROM child" }] }, { items: [{ target: "parent", sql: "DELETE FROM parent" }], dependencies: { parent: ["child"] } }], {
      keyOf: (target) => target,
      execute: async ({ target }) => {
        executed.push(target);
        throw new Error("permission denied");
      },
    });

    expect(executed).toEqual(["child"]);
    expect(result.failed.map(({ target }) => target)).toEqual(["child"]);
    expect(result.skipped?.map(({ target }) => target)).toEqual(["parent"]);
  });

  it("builds SQL previews with bounded concurrency", async () => {
    let active = 0;
    let peak = 0;
    const plan = await buildBatchTableEmptyPlan(
      Array.from({ length: 40 }, (_, index) => index),
      async (target) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return `DELETE FROM table_${target};`;
      },
    );

    expect(plan).toHaveLength(40);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("stops scheduling new SQL previews after the first build failure", async () => {
    let calls = 0;
    await expect(
      buildBatchTableEmptyPlan(
        Array.from({ length: 40 }, (_, index) => index),
        async (target) => {
          calls += 1;
          if (target === 0) throw new Error("preview failed");
          await new Promise((resolve) => setTimeout(resolve, 1));
          return `DELETE FROM table_${target};`;
        },
      ),
    ).rejects.toThrow("preview failed");

    expect(calls).toBeLessThanOrEqual(8);
  });
});
