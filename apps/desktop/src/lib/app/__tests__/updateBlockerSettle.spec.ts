import { describe, expect, it, vi } from "vitest";
import { hasUpdateSettleWork, settleUpdateWork, type UpdateSettleHost, type UpdateSettleItem, type UpdateSettleSnapshot } from "../updateBlockerSettle";

function item(id: string, label = id): UpdateSettleItem {
  return { id, label };
}

function makeState(initial: Partial<UpdateSettleSnapshot> = {}): UpdateSettleSnapshot {
  return { tasks: [], executions: [], explains: [], transactions: [], ...initial };
}

/** A host whose snapshot reads the mutable state, so removals look like real stops. */
function makeHost(state: UpdateSettleSnapshot) {
  const calls: string[] = [];
  const host: UpdateSettleHost = {
    snapshot: () => ({ tasks: [...state.tasks], executions: [...state.executions], explains: [...state.explains], transactions: [...state.transactions] }),
    cancelTask: async (id) => {
      calls.push(`cancelTask:${id}`);
      state.tasks = state.tasks.filter((task) => task.id !== id);
    },
    cancelExecution: async (id) => {
      calls.push(`cancelExecution:${id}`);
      state.executions = state.executions.filter((tab) => tab.id !== id);
    },
    cancelExplain: async (id) => {
      calls.push(`cancelExplain:${id}`);
      state.explains = state.explains.filter((tab) => tab.id !== id);
    },
    rollbackTransaction: async (id) => {
      calls.push(`rollback:${id}`);
      state.transactions = state.transactions.filter((tab) => tab.id !== id);
    },
  };
  return { host, calls };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("settleUpdateWork", () => {
  it("does nothing when no work is left", async () => {
    const { host, calls } = makeHost(makeState());
    await expect(settleUpdateWork(host)).resolves.toEqual([]);
    expect(calls).toEqual([]);
    expect(hasUpdateSettleWork(makeState())).toBe(false);
  });

  it("stops tasks and queries before rolling back an open transaction", async () => {
    const state = makeState({ tasks: [item("export-1")], executions: [item("tab-1")], transactions: [item("tab-2")] });
    const { host, calls } = makeHost(state);
    const rollback = vi.fn(host.rollbackTransaction);
    const observed: string[][] = [];
    host.rollbackTransaction = async (id) => {
      observed.push([...state.executions]);
      await rollback(id);
    };

    await expect(settleUpdateWork(host)).resolves.toEqual([]);

    expect(calls).toEqual(["cancelTask:export-1", "cancelExecution:tab-1", "rollback:tab-2"]);
    // The query must be gone by the time the transaction is rolled back.
    expect(observed).toEqual([[]]);
  });

  it("waits for a cancellation to finish before resolving", async () => {
    const state = makeState({ tasks: [item("export-1")] });
    const { host } = makeHost(state);
    const pending = deferred();
    host.cancelTask = async () => {
      await pending.promise;
      state.tasks = [];
    };

    let settled = false;
    const work = settleUpdateWork(host).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    pending.resolve();
    await work;
    expect(settled).toBe(true);
  });

  it("keeps the reason a cancellation failed instead of swallowing it", async () => {
    const state = makeState({ executions: [item("tab-1", "orders")] });
    const { host } = makeHost(state);
    host.cancelExecution = async () => {
      throw new Error("backend offline");
    };

    const failures = await settleUpdateWork(host, { timeoutMs: 10, pollMs: 1 });

    expect(failures).toEqual([{ kind: "execution", id: "tab-1", label: "orders", error: "backend offline" }]);
  });

  it("keeps the reason a transaction rollback failed", async () => {
    const { host } = makeHost(makeState({ transactions: [item("tab-1", "customers")] }));
    host.rollbackTransaction = async () => {
      throw new Error("rollback rejected");
    };

    await expect(settleUpdateWork(host, { timeoutMs: 10, pollMs: 1 })).resolves.toEqual([{ kind: "transaction", id: "tab-1", label: "customers", error: "rollback rejected" }]);
  });

  it("reports work that never stops, once, without an error", async () => {
    const { host } = makeHost(makeState({ executions: [item("tab-1", "orders")] }));
    host.cancelExecution = async () => true;

    const failures = await settleUpdateWork(host, { timeoutMs: 5, pollMs: 1 });

    expect(failures).toEqual([{ kind: "execution", id: "tab-1", label: "orders", error: undefined }]);
  });

  it("settles work that started after the prompt appeared", async () => {
    const state = makeState({ executions: [item("tab-1")] });
    const { host, calls } = makeHost(state);
    // The confirmation was raised for tab-1; a second query began meanwhile.
    state.executions = [...state.executions, item("tab-2")];

    await settleUpdateWork(host);

    expect(calls).toEqual(["cancelExecution:tab-1", "cancelExecution:tab-2"]);
  });

  it("re-reads transactions after the queries stop", async () => {
    const state = makeState({ executions: [item("tab-1")], transactions: [item("tab-2")] });
    const { host, calls } = makeHost(state);
    // The query's cancellation closed its transaction before the rollback step.
    host.cancelExecution = async (id) => {
      calls.push(`cancelExecution:${id}`);
      state.executions = [];
      state.transactions = [];
    };

    await settleUpdateWork(host);

    expect(calls).toEqual(["cancelExecution:tab-1"]);
    expect(calls).not.toContain("rollback:tab-2");
  });
});
