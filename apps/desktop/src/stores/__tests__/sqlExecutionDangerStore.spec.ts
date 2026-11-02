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

  it("asks a batch once and reuses the answer for its remaining targets", async () => {
    const store = useSqlExecutionDangerStore();
    const first = store.requestConfirmation({ sql: "UPDATE t", kind: "sql", scopeId: "batch-1" });
    expect(store.pending?.scopeId).toBe("batch-1");
    store.confirm();
    expect(await first).toBe(true);

    // The second target of the same batch must not prompt (nor ask for the
    // confirmation code) again.
    const second = store.requestConfirmation({ sql: "UPDATE t", kind: "sql", scopeId: "batch-1" });
    expect(store.pending).toBeUndefined();
    expect(await second).toBe(true);
  });

  it("keeps a declined batch from prompting the rest of its targets", async () => {
    const store = useSqlExecutionDangerStore();
    const first = store.requestConfirmation({ sql: "DROP TABLE a", kind: "sql", scopeId: "batch-2" });
    store.cancel();
    expect(await first).toBe(false);

    const second = store.requestConfirmation({ sql: "DROP TABLE a", kind: "sql", scopeId: "batch-2" });
    expect(store.pending).toBeUndefined();
    expect(await second).toBe(false);
  });

  it("resolves already-queued targets of the same batch with the first answer", async () => {
    const store = useSqlExecutionDangerStore();
    // Parallel execution can queue several targets before the operator answers.
    const first = store.requestConfirmation({ sql: "UPDATE t", kind: "sql", scopeId: "batch-3" });
    const second = store.requestConfirmation({ sql: "UPDATE t", kind: "sql", scopeId: "batch-3" });
    const other = store.requestConfirmation({ sql: "UPDATE u", kind: "sql", scopeId: "batch-4" });

    store.confirm();

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(store.pending?.scopeId).toBe("batch-4");
    store.cancel();
    expect(await other).toBe(false);
  });

  it("prompts again after the batch scope is cancelled", async () => {
    const store = useSqlExecutionDangerStore();
    const first = store.requestConfirmation({ sql: "UPDATE t", kind: "sql", scopeId: "batch-5" });
    store.confirm();
    await first;

    store.cancelScope("batch-5");

    const again = store.requestConfirmation({ sql: "UPDATE t", kind: "sql", scopeId: "batch-5" });
    expect(store.pending?.scopeId).toBe("batch-5");
    store.cancel();
    expect(await again).toBe(false);
  });

  it("keeps prompting for requests without a scope", async () => {
    const store = useSqlExecutionDangerStore();
    const first = store.requestConfirmation({ sql: "DROP TABLE a", kind: "sql" });
    store.confirm();
    expect(await first).toBe(true);

    const second = store.requestConfirmation({ sql: "DROP TABLE a", kind: "sql" });
    expect(store.pending).toBeDefined();
    store.cancel();
    expect(await second).toBe(false);
  });
});
