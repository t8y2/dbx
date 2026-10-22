import { effectScope, nextTick, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useSidebarSearchIndexes } from "@/composables/useSidebarSearchIndexes";
import { filterSidebarTree, mergeSidebarRegexIndexScopes, type SidebarRegexIndexScope } from "@/lib/sidebar/sidebarSearchTree";
import type { TreeNode } from "@/types/database";

const indexed: SidebarRegexIndexScope[] = [{ parentNodeId: "conn:app", connectionId: "conn", database: "app", nodeType: "database", entries: [{ name: "orders", table_type: "TABLE" }] }];

function fixture(load: (shouldCancel: () => boolean, onProgress: (scopes: SidebarRegexIndexScope[]) => void) => Promise<SidebarRegexIndexScope[]>) {
  const scope = effectScope();
  const query = ref("");
  const revision = ref(0);
  const onError = vi.fn();
  const state = scope.run(() => useSidebarSearchIndexes({ query, context: [() => revision.value], load, onError }))!;
  return { scope, query, revision, onError, ...state };
}

describe("global sidebar index session", () => {
  it("loads once while typing and filters cached entries without touching the backing tree", async () => {
    const load = vi.fn(async () => indexed);
    const state = fixture(load);
    const live: TreeNode[] = [{ id: "conn:app", label: "app", type: "database", connectionId: "conn", database: "app", isExpanded: false, children: [] }];
    try {
      for (const query of ["o", "or", "ord", "orders", "missing", "orders"]) {
        state.query.value = query;
        await nextTick();
        await nextTick();
        const projected = mergeSidebarRegexIndexScopes(live, state.scopes.value);
        const filtered = filterSidebarTree(projected, query, new Set());
        expect(filtered.length).toBe(query === "missing" ? 0 : 1);
        await vi.waitFor(() => expect(state.isLoading.value).toBe(false));
      }
      expect(load).toHaveBeenCalledTimes(1);
      expect(live[0].children).toEqual([]);
      expect(live[0].isExpanded).toBe(false);
      state.query.value = "";
      await nextTick();
      expect(state.scopes.value).toEqual([]);
      expect(load).toHaveBeenCalledTimes(1);
      expect(filterSidebarTree(live, "", new Set())).toBe(live);
    } finally {
      state.scope.stop();
    }
  });

  it("publishes cached progress while background index preparation is still running", async () => {
    let finish!: (scopes: SidebarRegexIndexScope[]) => void;
    const refreshed = [{ ...indexed[0], entries: [...indexed[0].entries, { name: "orders_archive", table_type: "TABLE" }] }];
    const state = fixture(
      (_cancel, publish) =>
        new Promise((resolve) => {
          publish(indexed);
          finish = resolve;
        }),
    );
    try {
      state.query.value = "orders";
      await nextTick();
      expect(state.scopes.value).toEqual(indexed);
      expect(state.isLoading.value).toBe(true);
      finish(refreshed);
      await nextTick();
      await nextTick();
      expect(state.scopes.value).toEqual(refreshed);
    } finally {
      state.scope.stop();
    }
  });

  it("shares a pending preparation while the keyword changes", async () => {
    let resolve!: (scopes: SidebarRegexIndexScope[]) => void;
    const load = vi.fn(
      () =>
        new Promise<SidebarRegexIndexScope[]>((complete) => {
          resolve = complete;
        }),
    );
    const state = fixture(load);
    try {
      state.query.value = "o";
      await nextTick();
      state.query.value = "orders";
      await nextTick();
      expect(state.isLoading.value).toBe(true);
      expect(load).toHaveBeenCalledTimes(1);
      resolve(indexed);
      await nextTick();
      await nextTick();
      expect(state.scopes.value).toEqual(indexed);
      await vi.waitFor(() => expect(state.isLoading.value).toBe(false));
    } finally {
      state.scope.stop();
    }
  });

  it("discards stale work across a refresh, connection change, or mode switch", async () => {
    const pending: Array<{ cancel: () => boolean; resolve: (scopes: SidebarRegexIndexScope[]) => void }> = [];
    const state = fixture((cancel) => new Promise((resolve) => pending.push({ cancel, resolve })));
    try {
      state.query.value = "orders";
      await nextTick();
      state.revision.value += 1;
      await nextTick();
      expect(pending[0].cancel()).toBe(true);
      pending[0].resolve(indexed);
      await nextTick();
      expect(state.scopes.value).toEqual([]);
      expect(state.isLoading.value).toBe(true);
      pending[1].resolve(indexed);
      await nextTick();
      await nextTick();
      expect(state.scopes.value).toEqual(indexed);
      await vi.waitFor(() => expect(state.isLoading.value).toBe(false));
    } finally {
      state.scope.stop();
    }
  });

  it.each(["clear", "unmount"])("ignores a late result after %s", async (action) => {
    let resolve!: (scopes: SidebarRegexIndexScope[]) => void;
    let shouldCancel!: () => boolean;
    const state = fixture((cancel) => {
      shouldCancel = cancel;
      return new Promise((complete) => {
        resolve = complete;
      });
    });
    state.query.value = "orders";
    await nextTick();
    if (action === "clear") state.query.value = "";
    else state.scope.stop();
    await nextTick();
    expect(shouldCancel()).toBe(true);
    resolve(indexed);
    await nextTick();
    expect(state.scopes.value).toEqual([]);
    state.scope.stop();
  });

  it("reports a load failure once and allows retry on refresh", async () => {
    const error = new Error("Metadata unavailable");
    const load = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(indexed);
    const state = fixture(load);
    try {
      state.query.value = "o";
      await nextTick();
      await nextTick();
      state.query.value = "orders";
      await nextTick();
      expect(state.onError).toHaveBeenCalledExactlyOnceWith(error);
      expect(load).toHaveBeenCalledTimes(1);
      state.revision.value += 1;
      await nextTick();
      await nextTick();
      expect(state.scopes.value).toEqual(indexed);
      await vi.waitFor(() => expect(state.isLoading.value).toBe(false));
    } finally {
      state.scope.stop();
    }
  });
});
