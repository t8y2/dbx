// @vitest-environment happy-dom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, SidebarLayout } from "@/types/database";

// Regression test for #13976: "分组设置后过段时间自动恢复原样".
// Root cause — initFromDisk reloaded the sidebar layout via loadSidebarLayout
// while a just-made grouping edit was still sitting in the 300ms debounced
// persistSidebarLayoutDebounced timer (or its fire-and-forget save was still
// in flight). The stale on-disk snapshot won and silently rolled the user's
// edit back. tableVGroup already flushed before reload (flushTableVGroupPersist);
// the connection-group layout lacked the symmetric flush. This test pins the
// symmetric flushSidebarLayoutPersist: it awaits a save of the current in-memory
// layout before initFromDisk reads it back, so the stale snapshot cannot win.

function connection(id: string): ConnectionConfig {
  return { id, name: id, db_type: "mysql", host: "127.0.0.1", port: 3306, username: "root", password: "", database: "app" };
}

describe("connectionStore sidebar layout flush before disk reload (#13976)", () => {
  let savedLayout: SidebarLayout | null;

  beforeEach(() => {
    vi.resetModules();
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    });
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    savedLayout = null;
    vi.doMock("@/lib/backend/api", () => ({
      loadConnections: vi.fn().mockResolvedValue([]),
      loadEditorSettings: vi.fn().mockResolvedValue(null),
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      listTables: vi.fn().mockResolvedValue([]),
      getColumns: vi.fn().mockResolvedValue([]),
      loadPinnedTreeNodeIds: vi.fn().mockResolvedValue([]),
      loadSidebarLayout: vi.fn().mockResolvedValue(null),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
      loadTableVGroups: vi.fn().mockResolvedValue({}),
      saveTableVGroups: vi.fn().mockResolvedValue(undefined),
      loadTunnelProfiles: vi.fn().mockResolvedValue([]),
      listObjects: vi.fn().mockResolvedValue([]),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveEditorSettings: vi.fn().mockResolvedValue(undefined),
      savePinnedTreeNodeIds: vi.fn().mockResolvedValue(undefined),
    }));
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("preserves a just-made grouping edit when a disk reload races inside the debounce window", { timeout: 60000 }, async () => {
    const api = await import("@/lib/backend/api");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    vi.mocked(api.loadConnections).mockResolvedValue([connection("c1"), connection("c2")]);

    const store = useConnectionStore();
    // Wire the load/save mocks to a shared snapshot so reload observes what the
    // flush wrote (mimicking a real store). After baseline, seed the stale
    // pre-edit snapshot a backup poll would read.
    vi.mocked(api.saveSidebarLayout).mockImplementation(async (layout: SidebarLayout) => {
      savedLayout = { groups: layout.groups.map((g) => ({ ...g })), order: layout.order.map((e) => ({ ...e })) };
    });
    vi.mocked(api.loadSidebarLayout).mockImplementation(async () => savedLayout);

    // Establish baseline: two ungrouped connections, empty layout on disk.
    await store.initFromDisk();
    expect(store.sidebarLayout.groups).toEqual([]);

    // Seed the stale on-disk snapshot (pre-edit) — what a backup poll would load.
    savedLayout = { groups: [], order: [] };

    // User groups c1 under a new "Work" group. Schedules a 300ms debounced save,
    // but the edit lives in memory only until the timer fires.
    const groupId = store.createConnectionGroup("Work", null);
    expect(groupId).toBeTruthy();
    store.moveConnectionToGroup("c1", groupId);
    expect(store.groupIdForConnection("c1")).toBe(groupId);
    expect(store.sidebarLayout.groups.map((g) => g.name)).toEqual(["Work"]);

    // A backup poll / scheduled reload triggers initFromDisk BEFORE the 300ms
    // debounce fires. flushSidebarLayoutPersist must await a save of the current
    // in-memory layout so loadSidebarLayout reads the edit back, not the stale
    // empty snapshot.
    await store.initFromDisk();

    // The edit survived the reload.
    expect(store.sidebarLayout.groups.map((g) => g.name)).toEqual(["Work"]);
    expect(store.groupIdForConnection("c1")).toBe(groupId);
    // And the persisted snapshot now reflects the edit (not the stale empty one).
    const saveCalls = vi.mocked(api.saveSidebarLayout).mock.calls;
    expect(saveCalls.length).toBeGreaterThan(0);
    const lastSaved = saveCalls[saveCalls.length - 1][0] as SidebarLayout;
    expect(lastSaved.groups.map((g) => g.name)).toEqual(["Work"]);
  });
});
