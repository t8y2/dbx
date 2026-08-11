import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";

describe("productionSafetyStore scope cancellation", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("cancels queued requests in the scope before advancing the confirmation queue", async () => {
    const store = useProductionSafetyStore();
    const first = store.requestConfirmation({ sql: "UPDATE a SET value = 1", scopeId: "batch-1" });
    const second = store.requestConfirmation({ sql: "UPDATE b SET value = 1", scopeId: "batch-1" });
    const unrelated = store.requestConfirmation({ sql: "UPDATE c SET value = 1", scopeId: "batch-2" });

    store.cancelScope("batch-1");

    expect(store.pending?.scopeId).toBe("batch-2");
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    store.confirm();
    expect(await unrelated).toBe(true);
    expect(store.pending).toBeUndefined();
  });
});
