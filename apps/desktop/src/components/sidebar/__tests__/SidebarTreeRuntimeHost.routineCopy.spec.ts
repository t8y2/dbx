// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { DatabaseType, TreeNode } from "@/types/database";

const mocks = vi.hoisted(() => ({
  source: vi.fn(),
  build: vi.fn(),
  execute: vi.fn(),
  clipboard: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  listPlugins: vi.fn().mockResolvedValue([]),
  getObjectSource: mocks.source,
  buildRoutineCopyObjectSourceSql: mocks.build,
  executeQuery: mocks.execute,
}));
vi.mock("@/lib/common/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/common/clipboard")>()),
  copyToClipboard: mocks.clipboard,
}));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { pasteRoutineError, pasteRoutineLoading, pasteRoutineName, resetSidebarTreeDialogState, showPasteRoutineDialog } from "@/components/sidebar/sidebarTreeDialogState";

const mountedApps: App<Element>[] = [];
const originalSource = "CREATE PROCEDURE public.calculate_total(IN id integer) LANGUAGE SQL AS $$ SELECT id; $$;";
const node = (type: TreeNode["type"] = "procedure", extra: Partial<TreeNode> = {}): TreeNode => ({
  id: `c:app:public:${type}:calculate_total`,
  type,
  label: "calculate_total(integer)",
  objectName: "calculate_total",
  signature: "integer",
  connectionId: "c",
  database: "app",
  schema: "public",
  ...extra,
});

async function flush() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

async function mountHost(databaseType: DatabaseType = "postgres") {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  store.connections = [{ id: "c", name: "Fixture", db_type: databaseType, driver_profile: databaseType, host: "localhost", port: 5432, username: "fixture" }];
  store.connectedIds.add("c");
  const routine = node();
  const rootNode: TreeNode = { id: "c", type: "connection", label: "Fixture", connectionId: "c", children: [routine] };
  store.treeNodes = [rootNode];
  store.selectedTreeNodeId = routine.id;
  store.selectedTreeNodeIds = [routine.id];
  vi.spyOn(store, "ensureConnected").mockResolvedValue(undefined as any);
  const refresh = vi.spyOn(store, "refreshObjectListTreeNode").mockResolvedValue(undefined as any);
  const hostRef = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
  let controller: Record<string, any> | null = null;
  const root = defineComponent({
    setup: () => () => h(SidebarTreeRuntimeHost, { ref: hostRef, node: rootNode, depth: 0, onOpenDialogController: (next: Record<string, any>) => (controller = next) }),
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(root);
  app.use(pinia);
  app.use(i18n);
  app.mount(container);
  mountedApps.push(app);
  await flush();
  return { host: hostRef.value as any, store, routine, refresh, controller: () => controller as Record<string, any> };
}

function setClipboard(store: ReturnType<typeof useConnectionStore>) {
  store.treeClipboard = { kind: "routine-copy", routine: { connectionId: "c", database: "app", schema: "public", name: "calculate_total", objectType: "PROCEDURE", signature: "integer" } };
}

describe("Routine copy/paste runtime (#13903)", () => {
  beforeEach(() => {
    resetSidebarTreeDialogState();
    mocks.source.mockReset().mockResolvedValue({ name: "calculate_total", schema: "public", object_type: "PROCEDURE", source: originalSource });
    mocks.build.mockReset().mockImplementation(async ({ newName }: { newName: string }) => `CREATE PROCEDURE public.${newName}(IN id integer) LANGUAGE SQL AS $$ SELECT id; $$;`);
    mocks.execute.mockReset().mockResolvedValue({ success: true, columns: [], rows: [] });
    mocks.clipboard.mockReset().mockResolvedValue(undefined);
    mocks.toast.mockReset();
  });

  afterEach(async () => {
    for (const app of mountedApps.splice(0)) app.unmount();
    resetSidebarTreeDialogState();
    document.body.innerHTML = "";
    await flush();
    vi.restoreAllMocks();
  });

  it("copies a selected overloaded procedure identity with Ctrl+C rather than losing the tree clipboard", async () => {
    const { host, store, routine } = await mountHost();
    const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
    host.handleRowKeydown(routine, event);
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(store.treeClipboard).toEqual({ kind: "routine-copy", routine: { connectionId: "c", database: "app", schema: "public", name: "calculate_total", objectType: "PROCEDURE", signature: "integer" } });
    expect(mocks.clipboard).toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("opens paste with a copy name and executes only the dedicated CREATE statement for the selected signature", async () => {
    const { host, store, routine, controller, refresh } = await mountHost();
    setClipboard(store);
    expect(host.requestPaste(routine)).toBe(true);
    expect(showPasteRoutineDialog.value).toBe(true);
    expect(pasteRoutineName.value).toBe("calculate_total_copy");
    expect(mocks.execute).not.toHaveBeenCalled();
    await controller().confirmPasteRoutine();
    expect(mocks.source.mock.calls[0]?.slice(0, 6)).toEqual(["c", "app", "public", "calculate_total", "PROCEDURE", "integer"]);
    expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({ databaseType: "postgres", objectType: "PROCEDURE", schema: "public", name: "calculate_total", newName: "calculate_total_copy", source: originalSource }));
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.execute.mock.calls[0]?.slice(0, 4)).toEqual(["c", "app", "CREATE PROCEDURE public.calculate_total_copy(IN id integer) LANGUAGE SQL AS $$ SELECT id; $$;", "public"]);
    expect(refresh).toHaveBeenCalledWith("c", "app", "public");
    expect(showPasteRoutineDialog.value).toBe(false);
  });

  it("leaves text-input copy shortcuts alone", async () => {
    const { host, store, routine } = await mountHost();
    const input = document.createElement("input");
    document.body.appendChild(input);
    const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    host.handleRowKeydown(routine, event);
    expect(event.defaultPrevented).toBe(false);
    expect(store.treeClipboard).toBeNull();
    expect(mocks.clipboard).not.toHaveBeenCalled();
  });

  it("continues creating the copy when ensureConnected refreshes discovered database metadata", async () => {
    const { host, store, routine, controller } = await mountHost();
    setClipboard(store);
    expect(host.requestPaste(routine)).toBe(true);
    const discoveredInfo = { productName: "PostgreSQL", productVersion: "17.6", currentDatabase: "app" };
    vi.mocked(store.ensureConnected).mockImplementationOnce(async (connectionId) => {
      expect(connectionId).toBe("c");
      // Real reconnection replaces the persisted configuration with a copy that
      // includes server-discovered metadata; this does not change the endpoint.
      store.connections = store.connections.map((config) => (config.id === connectionId ? { ...config, database_info: discoveredInfo } : config));
    });
    await controller().confirmPasteRoutine();
    expect(store.getConfig("c")?.database_info).toEqual(discoveredInfo);
    expect(mocks.source).toHaveBeenCalledTimes(1);
    expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({ name: "calculate_total", newName: "calculate_total_copy" }));
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.execute.mock.calls[0]?.slice(0, 2)).toEqual(["c", "app"]);
    expect(showPasteRoutineDialog.value).toBe(false);
  });

  it("does not CREATE if ensureConnected changes the actual connection endpoint", async () => {
    const { host, store, routine, controller } = await mountHost();
    setClipboard(store);
    expect(host.requestPaste(routine)).toBe(true);
    vi.mocked(store.ensureConnected).mockImplementationOnce(async (connectionId) => {
      store.connections = store.connections.map((config) => (config.id === connectionId ? { ...config, host: "different-endpoint.invalid", port: 6432 } : config));
    });
    await controller().confirmPasteRoutine();
    expect(store.getConfig("c")?.host).toBe("different-endpoint.invalid");
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(showPasteRoutineDialog.value).toBe(true);
    expect(pasteRoutineLoading.value).toBe(false);
  });

  it.each(["", "  ", "calculate_total"])("does not execute an empty or source-identical target name (%j)", async (name) => {
    const { host, store, routine, controller } = await mountHost();
    setClipboard(store);
    expect(host.requestPaste(routine)).toBe(true);
    pasteRoutineName.value = name;
    await controller().confirmPasteRoutine();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(showPasteRoutineDialog.value).toBe(true);
  });

  it("rejects paste into a read-only connection, another scope, or an Oracle package member", async () => {
    const { host, store, routine } = await mountHost();
    setClipboard(store);
    expect(host.requestPaste(node("procedure", { database: "other" }))).toBe(false);
    expect(host.requestPaste(node("procedure", { schema: "private" }))).toBe(false);
    expect(host.requestPaste(node("procedure", { parentType: "package", parentName: "pkg" }))).toBe(false);
    store.connections[0]!.read_only = true;
    expect(host.requestPaste(routine)).toBe(false);
    expect(showPasteRoutineDialog.value).toBe(false);
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("pins the source identity when tree selection changes while its definition is loading", async () => {
    const { host, store, routine, controller } = await mountHost();
    setClipboard(store);
    expect(host.requestPaste(routine)).toBe(true);
    let resolveSource!: (source: unknown) => void;
    mocks.source.mockImplementationOnce(() => new Promise((resolve) => (resolveSource = resolve)));
    const saving = controller().confirmPasteRoutine();
    await flush();
    expect(pasteRoutineLoading.value).toBe(true);
    host.buildContextMenu(node("procedure", { id: "other-proc", label: "other", objectName: "other", database: "other-db", schema: "other-schema" }));
    resolveSource({ name: "calculate_total", schema: "public", object_type: "PROCEDURE", source: originalSource });
    await saving;
    expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({ schema: "public", name: "calculate_total", newName: "calculate_total_copy" }));
    expect(mocks.execute.mock.calls[0]?.slice(0, 2)).toEqual(["c", "app"]);
    expect(mocks.execute.mock.calls[0]?.[3]).toBe("public");
  });

  it("keeps a failed creation editable so a different target name can be retried without dropping the original", async () => {
    const { host, store, routine, controller } = await mountHost();
    setClipboard(store);
    expect(host.requestPaste(routine)).toBe(true);
    mocks.execute.mockRejectedValueOnce(new Error("Procedure already exists"));
    await controller().confirmPasteRoutine();
    expect(showPasteRoutineDialog.value).toBe(true);
    expect(pasteRoutineError.value).toContain("Procedure already exists");
    expect(pasteRoutineLoading.value).toBe(false);
    pasteRoutineName.value = "calculate_total_copy_2";
    await controller().confirmPasteRoutine();
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.execute.mock.calls.map((call) => call[2])).toEqual(["CREATE PROCEDURE public.calculate_total_copy(IN id integer) LANGUAGE SQL AS $$ SELECT id; $$;", "CREATE PROCEDURE public.calculate_total_copy_2(IN id integer) LANGUAGE SQL AS $$ SELECT id; $$;"]);
    expect(showPasteRoutineDialog.value).toBe(false);
  });

  it("does not offer creation again when only the post-create tree refresh fails", async () => {
    const { host, store, routine, controller, refresh } = await mountHost();
    setClipboard(store);
    expect(host.requestPaste(routine)).toBe(true);
    refresh.mockRejectedValueOnce(new Error("Refresh unavailable"));
    await controller().confirmPasteRoutine();
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(showPasteRoutineDialog.value).toBe(false);
    await controller().confirmPasteRoutine();
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
});
