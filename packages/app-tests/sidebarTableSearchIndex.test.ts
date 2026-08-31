// Unit tests for the local table search index loading helper introduced for
// t8y2/dbx #6190.
//
// Pre-fix behavior: local-mode first search only read the persisted index
// (loadSidebarTableSearchIndex). When it had never been built (null), the UI
// fell back to the currently loaded first page of children, silently missing
// alphabetically-late tables (T_Erp_Nc_SuPlan_List for "erpncs").
//
// Post-fix behavior: a missing index is built on first use so the complete
// table set is searchable immediately — exactly once per scope even under
// rapid consecutive input (in-flight build deduplication + input debounce),
// and never for an empty (cleared) query.
import { expect, test, vi } from "vitest";
import assert from "node:assert/strict";
import { createSidebarTableSearchDebouncer, invalidateSidebarTableSearchBuild, loadOrBuildSidebarTableSearchIndex, scheduleExclusiveSidebarTableSearchDebounce } from "../../apps/desktop/src/lib/sidebar/sidebarTableSearchIndex.ts";
import type { TableInfo } from "../../apps/desktop/src/types/database.ts";

const TARGET: TableInfo = { name: "T_Erp_Nc_SuPlan_List", table_type: "TABLE", comment: null };

test("builds the index when the persisted index is missing (first search)", async () => {
  const read = async () => null;
  const build = vi.fn(async () => [TARGET]);
  const result = await loadOrBuildSidebarTableSearchIndex("scope", "erpncs", read, build);
  assert.deepEqual(result, [TARGET]);
  expect(build).toHaveBeenCalledTimes(1);
});

test("reuses the persisted index without rebuilding", async () => {
  const read = async () => [TARGET];
  const build = vi.fn(async () => []);
  const result = await loadOrBuildSidebarTableSearchIndex("scope", "erpncs", read, build);
  assert.deepEqual(result, [TARGET]);
  expect(build).not.toHaveBeenCalled();
});

test("an empty persisted index (no tables) is not treated as missing", async () => {
  const read = async () => [];
  const build = vi.fn(async () => [TARGET]);
  const result = await loadOrBuildSidebarTableSearchIndex("scope", "erpncs", read, build);
  assert.deepEqual(result, []);
  expect(build).not.toHaveBeenCalled();
});

test("an explicit refresh always rebuilds", async () => {
  const read = vi.fn(async () => [TARGET]);
  const build = vi.fn(async () => [{ name: "fresh", table_type: "TABLE", comment: null }]);
  const result = await loadOrBuildSidebarTableSearchIndex("scope", "", read, build, true);
  assert.deepEqual(result, [{ name: "fresh", table_type: "TABLE", comment: null }]);
  expect(build).toHaveBeenCalledTimes(1);
});

test("an empty query never reads or builds (clearing the input is a no-op)", async () => {
  const read = vi.fn(async () => null);
  const build = vi.fn(async () => [TARGET]);
  const result = await loadOrBuildSidebarTableSearchIndex("scope", "   ", read, build);
  assert.equal(result, null);
  expect(read).not.toHaveBeenCalled();
  expect(build).not.toHaveBeenCalled();
});

test("concurrent first-use searches share a single in-flight build", async () => {
  const read = async () => null;
  const build = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return [TARGET];
  });
  const [first, second] = await Promise.all([loadOrBuildSidebarTableSearchIndex("scope", "erpncs", read, build), loadOrBuildSidebarTableSearchIndex("scope", "erpncs", read, build)]);
  assert.deepEqual(first, [TARGET]);
  assert.deepEqual(second, [TARGET]);
  expect(build).toHaveBeenCalledTimes(1);
});

test("parallel builds for different scopes run independently", async () => {
  const read = async () => null;
  const buildA = vi.fn(async () => [TARGET]);
  const buildB = vi.fn(async () => [{ name: "other", table_type: "TABLE", comment: null }]);
  const [a, b] = await Promise.all([loadOrBuildSidebarTableSearchIndex("scope-a", "erpncs", read, buildA), loadOrBuildSidebarTableSearchIndex("scope-b", "erpncs", read, buildB)]);
  assert.deepEqual(a, [TARGET]);
  assert.deepEqual(b, [{ name: "other", table_type: "TABLE", comment: null }]);
  expect(buildA).toHaveBeenCalledTimes(1);
  expect(buildB).toHaveBeenCalledTimes(1);
});

test("a settled build is released so a later search can rebuild", async () => {
  const read = async () => null;
  const build = vi.fn(async () => [TARGET]);
  await loadOrBuildSidebarTableSearchIndex("scope", "erpncs", read, build);
  await loadOrBuildSidebarTableSearchIndex("scope", "erpncs", read, build);
  expect(build).toHaveBeenCalledTimes(2);
});

test("concurrent refreshes for the same scope share a single in-flight build", async () => {
  const read = async () => null;
  const build = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return [TARGET];
  });
  const results = await Promise.all([loadOrBuildSidebarTableSearchIndex("scope", "", read, build, true), loadOrBuildSidebarTableSearchIndex("scope", "", read, build, true)]);
  assert.deepEqual(results, [[TARGET], [TARGET]]);
  expect(build).toHaveBeenCalledTimes(1);
});

test("invalidating a scope lets a replacement build bypass stale in-flight work", async () => {
  let releaseStale!: () => void;
  const staleGate = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });
  let releaseFresh!: () => void;
  const freshGate = new Promise<void>((resolve) => {
    releaseFresh = resolve;
  });
  const staleBuild = vi.fn(async () => {
    await staleGate;
    return [TARGET];
  });
  const fresh = { name: "fresh", table_type: "TABLE", comment: null } satisfies TableInfo;
  const freshBuild = vi.fn(async () => {
    await freshGate;
    return [fresh];
  });

  const staleRequest = loadOrBuildSidebarTableSearchIndex("scope-invalidated", "old", async () => null, staleBuild, true);
  await vi.waitFor(() => expect(staleBuild).toHaveBeenCalledTimes(1));
  invalidateSidebarTableSearchBuild("scope-invalidated");
  const freshRequest = loadOrBuildSidebarTableSearchIndex("scope-invalidated", "fresh", async () => null, freshBuild, true);

  await vi.waitFor(() => expect(freshBuild).toHaveBeenCalledTimes(1));
  releaseStale();
  await expect(staleRequest).resolves.toEqual([TARGET]);
  const concurrentFreshRequest = loadOrBuildSidebarTableSearchIndex("scope-invalidated", "fresh", async () => null, freshBuild, true);
  expect(freshBuild).toHaveBeenCalledTimes(1);
  releaseFresh();
  await expect(Promise.all([freshRequest, concurrentFreshRequest])).resolves.toEqual([[fresh], [fresh]]);
});

test("rapid consecutive schedules coalesce into a single run", () => {
  vi.useFakeTimers();
  try {
    const debouncer = createSidebarTableSearchDebouncer(250);
    const run = vi.fn();
    debouncer.schedule("parent-1", () => run("parent-1"));
    debouncer.schedule("parent-1", () => run("parent-1"));
    debouncer.schedule("parent-1", () => run("parent-1"));
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(249);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("parent-1");
    expect(debouncer.pendingCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("different keys debounce independently", () => {
  vi.useFakeTimers();
  try {
    const debouncer = createSidebarTableSearchDebouncer(100);
    const run = vi.fn();
    debouncer.schedule("parent-1", () => run("parent-1"));
    debouncer.schedule("parent-2", () => run("parent-2"));
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(1, "parent-1");
    expect(run).toHaveBeenNthCalledWith(2, "parent-2");
  } finally {
    vi.useRealTimers();
  }
});

test("cancel drops a pending schedule", () => {
  vi.useFakeTimers();
  try {
    const debouncer = createSidebarTableSearchDebouncer(250);
    const run = vi.fn();
    debouncer.schedule("parent-1", () => run());
    expect(debouncer.pendingCount()).toBe(1);
    debouncer.cancel("parent-1");
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
    expect(debouncer.pendingCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("cancelAll drops every pending schedule", () => {
  vi.useFakeTimers();
  try {
    const debouncer = createSidebarTableSearchDebouncer(100);
    const run = vi.fn();
    debouncer.schedule("parent-1", () => run());
    debouncer.schedule("parent-2", () => run());
    expect(debouncer.pendingCount()).toBe(2);
    debouncer.cancelAll();
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
    expect(debouncer.pendingCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("switching search modes cancels the pending debounce from the other mode", () => {
  vi.useFakeTimers();
  try {
    const local = createSidebarTableSearchDebouncer(250);
    const remote = createSidebarTableSearchDebouncer(250);
    const localRun = vi.fn();
    const remoteRun = vi.fn();

    scheduleExclusiveSidebarTableSearchDebounce("parent-1", local, remote, localRun);
    scheduleExclusiveSidebarTableSearchDebounce("parent-1", remote, local, remoteRun);
    vi.advanceTimersByTime(250);

    expect(localRun).not.toHaveBeenCalled();
    expect(remoteRun).toHaveBeenCalledTimes(1);
    expect(local.pendingCount()).toBe(0);
    expect(remote.pendingCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
