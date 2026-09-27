import { describe, expect, it, vi } from "vitest";
import { isBatchSelectableListing, runBatch } from "@/lib/plugins/pluginBatch";

describe("runBatch", () => {
  it("runs items sequentially and records all successes", async () => {
    const order: string[] = [];
    const outcome = await runBatch(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      (item) => item.id,
      async (item) => {
        order.push(item.id);
      },
    );
    expect(order).toEqual(["a", "b", "c"]);
    expect(outcome.succeeded).toEqual(["a", "b", "c"]);
    expect(outcome.failed).toEqual([]);
  });

  it("captures a failing item, continues, and does not roll back", async () => {
    const ran: string[] = [];
    const outcome = await runBatch(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      (item) => item.id,
      async (item) => {
        ran.push(item.id);
        if (item.id === "b") throw new Error("boom");
      },
    );
    expect(ran).toEqual(["a", "b", "c"]);
    expect(outcome.succeeded).toEqual(["a", "c"]);
    expect(outcome.failed).toEqual([{ name: "b", error: "boom" }]);
  });

  it("returns an empty outcome for empty input", async () => {
    const action = vi.fn();
    const outcome = await runBatch([], (item: { id: string }) => item.id, action);
    expect(action).not.toHaveBeenCalled();
    expect(outcome.succeeded).toEqual([]);
    expect(outcome.failed).toEqual([]);
  });
});

describe("isBatchSelectableListing", () => {
  it("allows install and update, blocks installed and unsupported", () => {
    expect(isBatchSelectableListing("install")).toBe(true);
    expect(isBatchSelectableListing("update")).toBe(true);
    expect(isBatchSelectableListing("installed")).toBe(false);
    expect(isBatchSelectableListing("unsupported")).toBe(false);
  });
});
