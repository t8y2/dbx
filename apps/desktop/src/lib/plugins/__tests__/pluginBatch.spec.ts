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
      (item) => item.id,
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
      (item) => item.id,
    );
    expect(ran).toEqual(["a", "b", "c"]);
    expect(outcome.succeeded).toEqual(["a", "c"]);
    expect(outcome.failed).toEqual([{ id: "b", name: "b", error: "boom" }]);
  });

  it("records the item identity for a non-Error rejection too", async () => {
    const outcome = await runBatch(
      [{ id: "a" }, { id: "b" }],
      (item) => item.id,
      async (item) => {
        if (item.id === "b") throw "denied";
      },
      (item) => item.id,
    );
    expect(outcome.failed).toEqual([{ id: "b", name: "b", error: "denied" }]);
  });

  it("reads identity and label before the action can destroy them", async () => {
    // A failed action may leave the item unusable (see the plugin store leaving a half-replaced
    // version dir behind), so the failure has to carry the identity captured up front.
    const outcome = await runBatch(
      [{ id: "a" }],
      (item) => item.id,
      async (item) => {
        item.id = "";
        throw new Error("boom");
      },
      (item) => item.id,
    );
    expect(outcome.failed).toEqual([{ id: "a", name: "a", error: "boom" }]);
  });

  it("returns an empty outcome for empty input", async () => {
    const action = vi.fn();
    const outcome = await runBatch(
      [],
      (item: { id: string }) => item.id,
      action,
      (item: { id: string }) => item.id,
    );
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
