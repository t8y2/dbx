import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSqlExecutionDangerStore } from "@/stores/sqlExecutionDangerStore";

describe("sqlExecutionDangerStore", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("cancels all requests in a batch without promoting another request from that batch", async () => {
    const store = useSqlExecutionDangerStore();
    const first = store.requestConfirmation({ sql: "DROP TABLE a", kind: "sql", scopeId: "batch-1" });
    const second = store.requestConfirmation({ sql: "DROP TABLE b", kind: "sql", scopeId: "batch-1" });
    const unrelated = store.requestConfirmation({ sql: "DROP TABLE c", kind: "sql", scopeId: "batch-2" });

    store.cancelScope("batch-1");

    expect(store.pending?.scopeId).toBe("batch-2");
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    store.confirm();
    expect(await unrelated).toBe(true);
    expect(store.pending).toBeUndefined();
  });
});
