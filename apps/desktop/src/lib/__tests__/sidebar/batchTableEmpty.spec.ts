import { describe, expect, it } from "vitest";
import { batchTableEmptyFeedback, runBatchTableEmpty } from "@/lib/sidebar/batchTableEmpty";

describe("batch table empty", () => {
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
