/**
 * Settles the work that holds an update back: background tasks, running
 * queries/plans and manual transactions.
 *
 * The confirmation that grants this is destructive, so order and failure
 * reporting matter: queries and tasks must be observed as *stopped* before a
 * transaction is rolled back, and a cancellation or rollback that fails has to
 * reach the caller instead of being dropped — an install that half-cleaned the
 * editor would kill work nobody agreed to lose.
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
  cancelExecution(id: string): Promise<unknown>;
  cancelExplain(id: string): Promise<unknown>;
  rollbackTransaction(id: string): Promise<unknown>;
}

export type UpdateSettleFailureKind = "task" | "execution" | "explain" | "transaction";

export interface UpdateSettleFailure {
  kind: UpdateSettleFailureKind;
  id: string;
  label: string;
  /** Why the call failed; absent when the work simply never stopped. */
  error?: string;
}

export interface UpdateSettleOptions {
  /** How long to wait for cancellations to take effect. */
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

/** Turn a synchronous throw into a rejection so every call goes through allSettled. */
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
  const record = (kind: UpdateSettleFailureKind, item: UpdateSettleItem, error?: string) => {
    const key = `${kind}:${item.id}`;
    if (failed.has(key)) return;
    failed.add(key);
    failures.push({ kind, id: item.id, label: item.label, error });
  };

  // 1. Background tasks own connections of their own but may also hold a query's
  //    connection open; stop and wait for them before touching tabs.
  const tasks = host.snapshot().tasks;
  const taskResults = await Promise.allSettled(tasks.map((task) => started(() => host.cancelTask(task.id))));
  taskResults.forEach((result, index) => {
    if (result.status === "rejected") record("task", tasks[index], errorMessage(result.reason));
  });
  await waitUntil(() => host.snapshot().tasks.length === 0, timeoutMs, pollMs);
  for (const task of host.snapshot().tasks) record("task", task);

  // 2. Queries and plans: request cancellation, then wait for the tabs to leave
  //    the executing state — the backend acknowledging a cancel is not the query
  //    having stopped.
  const { executions, explains } = host.snapshot();
  const cancels: Array<{ kind: "execution" | "explain"; item: UpdateSettleItem; promise: Promise<unknown> }> = [
    ...executions.map((item) => ({ kind: "execution" as const, item, promise: started(() => host.cancelExecution(item.id)) })),
    ...explains.map((item) => ({ kind: "explain" as const, item, promise: started(() => host.cancelExplain(item.id)) })),
  ];
  const cancelResults = await Promise.allSettled(cancels.map((entry) => entry.promise));
  cancelResults.forEach((result, index) => {
    if (result.status === "rejected") record(cancels[index].kind, cancels[index].item, errorMessage(result.reason));
  });
  await waitUntil(() => host.snapshot().executions.length === 0 && host.snapshot().explains.length === 0, timeoutMs, pollMs);
  const afterCancels = host.snapshot();
  for (const item of afterCancels.executions) record("execution", item);
  for (const item of afterCancels.explains) record("explain", item);

  // 3. Only now roll back the transactions that are still open. Re-read the list:
  //    a transaction may have closed, or another query may have opened one.
  const transactions = host.snapshot().transactions;
  const rollbackResults = await Promise.allSettled(transactions.map((item) => started(() => host.rollbackTransaction(item.id))));
  rollbackResults.forEach((result, index) => {
    if (result.status === "rejected") record("transaction", transactions[index], errorMessage(result.reason));
  });
  await waitUntil(() => host.snapshot().transactions.length === 0, timeoutMs, pollMs);
  for (const item of host.snapshot().transactions) record("transaction", item);

  return failures;
}
