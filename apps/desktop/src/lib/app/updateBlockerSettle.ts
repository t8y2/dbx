/**
 * Settles the work that holds an update back: background tasks, running
 * queries/plans and manual transactions.
 *
 * The confirmation that grants this is destructive, so order and failure
 * reporting matter: queries and tasks must be observed as *stopped* before a
 * transaction is rolled back, and a cancellation or rollback that fails — by
 * throwing, by answering `false`, or by never answering — has to reach the
 * caller instead of being dropped. An install that half-cleaned the editor
 * would kill work nobody agreed to lose.
 */

export interface UpdateSettleItem {
  id: string;
  /** Shown in the failure message: the tab title, or the task's table/kind. */
  label: string;
}

export interface UpdateSettleSnapshot {
  /** Background tasks that are still running and can be cancelled. */
  tasks: UpdateSettleItem[];
  /** Tabs executing a query, including the ones already asked to stop. */
  executions: UpdateSettleItem[];
  /** Tabs executing an explain plan. */
  explains: UpdateSettleItem[];
  /** Manual transactions that are still open. */
  transactions: UpdateSettleItem[];
}

export interface UpdateSettleHost {
  /** Read fresh at every step: work may have started since the prompt appeared. */
  snapshot(): UpdateSettleSnapshot;
  cancelTask(id: string): Promise<unknown>;
  /** Resolves `false` when the backend did not acknowledge the cancellation. */
  cancelExecution(id: string): Promise<unknown>;
  /** Resolves `false` when the backend did not acknowledge the cancellation. */
  cancelExplain(id: string): Promise<unknown>;
  rollbackTransaction(id: string): Promise<unknown>;
}

export type UpdateSettleFailureKind = "task" | "execution" | "explain" | "transaction";

export type UpdateSettleFailureReason =
  /** The call rejected; `error` carries the backend's message. */
  | "rejected"
  /** The call answered `false` or never returned: stopping was not confirmed. */
  | "unconfirmed"
  /** The call succeeded but the work is still there after the wait. */
  | "still-running";

export interface UpdateSettleFailure {
  kind: UpdateSettleFailureKind;
  id: string;
  label: string;
  reason: UpdateSettleFailureReason;
  /** Backend message, present for `rejected`. */
  error?: string;
}

export interface UpdateSettleOptions {
  /** How long each phase may take, including a call that never returns. */
  timeoutMs?: number;
  pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 100;

export function hasUpdateSettleWork(snapshot: UpdateSettleSnapshot): boolean {
  return snapshot.tasks.length > 0 || snapshot.executions.length > 0 || snapshot.explains.length > 0 || snapshot.transactions.length > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Turn a synchronous throw into a rejection so every call goes through the same path. */
function started(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(error);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SettleCall {
  kind: UpdateSettleFailureKind;
  item: UpdateSettleItem;
  promise: Promise<unknown>;
  /** `false` means the host refused or did not acknowledge the request. */
  acknowledgement: boolean;
}

type CallOutcome = { call: SettleCall; result: PromiseSettledResult<unknown> | "timeout" };

/**
 * Wait for the calls, but never longer than the phase budget: a cancel or
 * rollback whose backend never answers must not hang the confirmation.
 */
async function runCalls(calls: SettleCall[], timeoutMs: number): Promise<CallOutcome[]> {
  const results = new Map<number, PromiseSettledResult<unknown>>();
  const all = Promise.all(
    calls.map((call, index) =>
      call.promise.then(
        (value) => {
          results.set(index, { status: "fulfilled", value });
        },
        (reason) => {
          results.set(index, { status: "rejected", reason });
        },
      ),
    ),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    all,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return calls.map((call, index) => ({ call, result: results.get(index) ?? "timeout" }));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, pollMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return;
    await delay(pollMs);
  }
}

/**
 * Stops everything that blocks an update and returns the reasons it could not.
 * An empty list means the editor is settled and the install may proceed.
 */
export async function settleUpdateWork(host: UpdateSettleHost, options: UpdateSettleOptions = {}): Promise<UpdateSettleFailure[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const failures: UpdateSettleFailure[] = [];
  const failed = new Set<string>();
  const record = (kind: UpdateSettleFailureKind, item: UpdateSettleItem, reason: UpdateSettleFailureReason, error?: string) => {
    const key = `${kind}:${item.id}`;
    if (failed.has(key)) return;
    failed.add(key);
    failures.push({ kind, id: item.id, label: item.label, reason, ...(error === undefined ? {} : { error }) });
  };
  const collect = (outcomes: CallOutcome[]) => {
    for (const { call, result } of outcomes) {
      if (result === "timeout") record(call.kind, call.item, "unconfirmed");
      else if (result.status === "rejected") record(call.kind, call.item, "rejected", errorMessage(result.reason));
      else if (call.acknowledgement && result.value === false) record(call.kind, call.item, "unconfirmed");
    }
  };

  // 1. Background tasks own connections of their own but may also hold a query's
  //    connection open; stop and wait for them before touching tabs.
  const tasks = host.snapshot().tasks;
  collect(
    await runCalls(
      tasks.map((item) => ({ kind: "task" as const, item, promise: started(() => host.cancelTask(item.id)), acknowledgement: false })),
      timeoutMs,
    ),
  );
  await waitUntil(() => host.snapshot().tasks.length === 0, timeoutMs, pollMs);
  for (const task of host.snapshot().tasks) record("task", task, "still-running");

  // 2. Queries and plans: request cancellation, then wait for the tabs to leave
  //    the executing state — the backend acknowledging a cancel is not the query
  //    having stopped. A `false` answer means the cancellation was not accepted,
  //    and the store clears its local state anyway, so it must be reported here.
  const { executions, explains } = host.snapshot();
  const cancels: SettleCall[] = [
    ...executions.map((item) => ({ kind: "execution" as const, item, promise: started(() => host.cancelExecution(item.id)), acknowledgement: true })),
    ...explains.map((item) => ({ kind: "explain" as const, item, promise: started(() => host.cancelExplain(item.id)), acknowledgement: true })),
  ];
  collect(await runCalls(cancels, timeoutMs));
  await waitUntil(() => host.snapshot().executions.length === 0 && host.snapshot().explains.length === 0, timeoutMs, pollMs);
  const afterCancels = host.snapshot();
  for (const item of afterCancels.executions) record("execution", item, "still-running");
  for (const item of afterCancels.explains) record("explain", item, "still-running");

  // 3. Only now roll back the transactions that are still open. Re-read the list:
  //    a transaction may have closed, or another query may have opened one.
  const transactions = host.snapshot().transactions;
  collect(
    await runCalls(
      transactions.map((item) => ({ kind: "transaction" as const, item, promise: started(() => host.rollbackTransaction(item.id)), acknowledgement: false })),
      timeoutMs,
    ),
  );
  await waitUntil(() => host.snapshot().transactions.length === 0, timeoutMs, pollMs);
  for (const item of host.snapshot().transactions) record("transaction", item, "still-running");

  return failures;
}
