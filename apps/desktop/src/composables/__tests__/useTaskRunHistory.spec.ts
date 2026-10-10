import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRun, TaskRunPage } from "@/lib/backend/tauri";

vi.mock("@/lib/backend/api", () => ({ loadTaskRuns: vi.fn() }));

import { useTaskRunHistory } from "@/composables/useTaskRunHistory";
import * as api from "@/lib/backend/api";

const loadTaskRuns = vi.mocked(api.loadTaskRuns);

function run(runId: string, createdAt = "2025-03-05T10:00:00.000Z"): TaskRun {
  return {
    runId,
    taskType: "transfer",
    lifecycleOwner: "tauri",
    status: "succeeded",
    createdAt,
    startedAt: createdAt,
    finishedAt: "2025-03-05T10:00:05.000Z",
    ownerInstanceId: "instance-1",
    errorCode: null,
    safeErrorSummary: null,
    historyComplete: true,
    source: { connectionId: "src", databaseType: "mysql", database: "shop", schema: "" },
    target: { connectionId: "dst", databaseType: "postgres", database: "warehouse", schema: "public" },
  };
}

function page(items: TaskRun[], nextCursor: TaskRunPage["nextCursor"] = null): TaskRunPage {
  return { items, nextCursor };
}

beforeEach(() => {
  loadTaskRuns.mockReset();
});

describe("useTaskRunHistory", () => {
  it("loads the first page with the page size and without a cursor", async () => {
    loadTaskRuns.mockResolvedValue(page([run("run-1")]));

    const history = useTaskRunHistory(30);
    await history.loadFirstPage({ taskType: "transfer", sourceQuery: "app" });

    expect(loadTaskRuns).toHaveBeenCalledWith({ taskType: "transfer", sourceQuery: "app", limit: 30, cursor: undefined });
    expect(history.runs.value.map((item) => item.runId)).toEqual(["run-1"]);
    expect(history.loading.value).toBe(false);
    expect(history.failed.value).toBe(false);
    expect(history.hasMore.value).toBe(false);
  });

  it("requests the next page with the returned cursor and appends without duplicating runs", async () => {
    loadTaskRuns.mockResolvedValueOnce(page([run("run-1"), run("run-2")], { createdAt: "2025-03-05T10:00:00.000Z", runId: "run-2" })).mockResolvedValueOnce(page([run("run-2"), run("run-3")], null));

    const history = useTaskRunHistory(2);
    await history.loadFirstPage();
    expect(history.hasMore.value).toBe(true);

    await history.loadMore();

    expect(loadTaskRuns).toHaveBeenLastCalledWith({ limit: 2, cursor: { createdAt: "2025-03-05T10:00:00.000Z", runId: "run-2" } });
    expect(history.runs.value.map((item) => item.runId)).toEqual(["run-1", "run-2", "run-3"]);
    expect(history.hasMore.value).toBe(false);
  });

  it("stops paging without a cursor or while a request is already in flight", async () => {
    loadTaskRuns.mockResolvedValue(page([run("run-1")]));

    const history = useTaskRunHistory(5);
    await history.loadFirstPage();
    await history.loadMore();

    expect(loadTaskRuns).toHaveBeenCalledTimes(1);
  });

  it("ignores a slow response that belongs to a superseded query", async () => {
    let resolveFirst: (value: TaskRunPage) => void = () => {};
    loadTaskRuns
      .mockImplementationOnce(
        () =>
          new Promise<TaskRunPage>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(page([run("fresh")]));

    const history = useTaskRunHistory(10);
    const stale = history.loadFirstPage({ status: "failed" });
    await history.loadFirstPage({ status: "succeeded" });
    resolveFirst(page([run("stale")]));
    await stale;

    expect(history.runs.value.map((item) => item.runId)).toEqual(["fresh"]);
    expect(history.failed.value).toBe(false);
  });

  it("reports a failure and lets retry reuse the last applied query", async () => {
    loadTaskRuns.mockRejectedValueOnce(new Error("storage offline")).mockResolvedValueOnce(page([run("run-1")]));

    const history = useTaskRunHistory(10);
    await history.loadFirstPage({ targetQuery: "warehouse" });

    expect(history.failed.value).toBe(true);
    expect(history.runs.value).toEqual([]);

    await history.retry();

    expect(loadTaskRuns).toHaveBeenLastCalledWith({ targetQuery: "warehouse", limit: 10, cursor: undefined });
    expect(history.failed.value).toBe(false);
    expect(history.runs.value.map((item) => item.runId)).toEqual(["run-1"]);
  });

  it("invalidate drops loaded state and discards a response that is still pending", async () => {
    let resolvePending: (value: TaskRunPage) => void = () => {};
    loadTaskRuns.mockImplementationOnce(
      () =>
        new Promise<TaskRunPage>((resolve) => {
          resolvePending = resolve;
        }),
    );

    const history = useTaskRunHistory(10);
    const pending = history.loadFirstPage();
    history.invalidate();
    resolvePending(page([run("run-1")]));
    await pending;

    expect(history.runs.value).toEqual([]);
    expect(history.loading.value).toBe(false);
    expect(history.hasMore.value).toBe(false);
  });
});
