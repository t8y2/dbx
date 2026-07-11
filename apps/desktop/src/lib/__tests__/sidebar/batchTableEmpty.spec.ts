import { describe, expect, it } from "vitest";
import { batchTableEmptyFeedback, buildBatchTableEmptyPlan, runBatchTableEmpty } from "@/lib/sidebar/batchTableEmpty";

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

    expect(batchTableEmptyFeedback(succeeded, true)).toBe("submitted");
    expect(batchTableEmptyFeedback(partial, true)).toBe("submitted-partial");
    expect(batchTableEmptyFeedback(failed, true)).toBe("submitted-partial");
    expect(batchTableEmptyFeedback(succeeded, false)).toBe("success");
    expect(batchTableEmptyFeedback(partial, false)).toBe("partial");
    expect(batchTableEmptyFeedback(failed, false)).toBe("partial");
  });
});
