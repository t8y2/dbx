import { describe, expect, it } from "vitest";
import { createObjectBrowserRowsLoadGuard } from "@/lib/table/objectBrowserRowsLoadGuard";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ObjectBrowserRowsLoadGuard", () => {
  it.each([
    {
      name: "connection",
      nextScope: { connectionId: "new", database: "db1", schema: "public" },
    },
    {
      name: "database",
      nextScope: { connectionId: "old", database: "db2", schema: "public" },
    },
  ])("drops statistics that finish after switching $name", async ({ nextScope }) => {
    const guard = createObjectBrowserRowsLoadGuard();
    const oldRequest = guard.start({ connectionId: "old", database: "db1", schema: "public" });
    const pendingStatistics = deferred<number>();
    const cacheWrites: Array<{ connectionId: string; database: string }> = [];
    const oldStatisticsTask = (async () => {
      await pendingStatistics.promise;
      if (!guard.isCurrent(oldRequest)) return;
      cacheWrites.push(oldRequest.scope);
    })();

    guard.invalidate();
    const currentRequest = guard.start(nextScope);
    pendingStatistics.resolve(1);
    await oldStatisticsTask;

    expect(guard.isCurrent(oldRequest)).toBe(false);
    expect(guard.isCurrent(currentRequest)).toBe(true);
    expect(oldRequest.scope).toMatchObject({ connectionId: "old", database: "db1" });
    expect(cacheWrites).toEqual([]);
  });

  it("captures an immutable copy of the complete cache scope", () => {
    const guard = createObjectBrowserRowsLoadGuard();
    const scope = { connectionId: "c1", database: "db1", schema: "public", catalog: "catalog1" };
    const request = guard.start(scope);

    scope.database = "db2";

    expect(request.scope).toEqual({ connectionId: "c1", database: "db1", schema: "public", catalog: "catalog1" });
    expect(Object.isFrozen(request.scope)).toBe(true);
  });
});
