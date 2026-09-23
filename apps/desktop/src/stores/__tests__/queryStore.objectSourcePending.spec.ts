import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

// issue #9035：源码 tab 必须先出现再加载。这批用例锁定 pending 占位 tab 的
// 行为契约：立即出现、原地填充、就地重试、加载中被关闭则丢弃、重复点击去重。
const mocks = vi.hoisted(() => {
  const connectionStore = {
    activeConnectionId: null as string | null,
    ensureConnected: vi.fn(async () => {}),
    dbType: "oracle",
    getConfig: (connectionId: string) => (connectionId ? { id: connectionId, name: connectionId, db_type: connectionStore.dbType } : undefined),
  };
  return {
    connectionStore,
    ensureConnected: connectionStore.ensureConnected,
    getObjectSource: vi.fn(),
    buildEditableObjectSource: vi.fn(async (input: { source: string }) => input.source),
    closeQuerySession: vi.fn(async () => {}),
    closeClientConnectionSession: vi.fn(async () => {}),
    saveOpenTabsState: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/backend/api", () => ({
  getObjectSource: (...args: unknown[]) => mocks.getObjectSource(...args),
  buildEditableObjectSource: (input: { source: string }) => mocks.buildEditableObjectSource(input),
  closeQuerySession: mocks.closeQuerySession,
  closeClientConnectionSession: mocks.closeClientConnectionSession,
  saveOpenTabsState: mocks.saveOpenTabsState,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => mocks.connectionStore,
}));

const CONNECTION_ID = "ora-1";
const DATABASE = "ORCL";
const SCHEMA = "APP";

const pendingOptions = (request: { name: string; objectType: "VIEW" | "PROCEDURE" | "FUNCTION" | "SEQUENCE"; signature?: string }) => ({
  connectionId: CONNECTION_ID,
  database: DATABASE,
  title: `Source - ${request.name}`,
  schema: SCHEMA,
  request,
});

const objectSource = (source: string, editable?: boolean) => ({
  name: "ignored",
  object_type: "VIEW" as const,
  source,
  ...(editable === undefined ? {} : { editable }),
});

/** 让 loader 的 await 链跑完（ensureConnected → getObjectSource → 落地）。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("queryStore pending object source tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
    setActivePinia(createPinia());
    mocks.connectionStore.dbType = "oracle";
  });

  it("creates a visible loading tab before the source arrives", async () => {
    let resolveSource: ((value: unknown) => void) | undefined;
    mocks.getObjectSource.mockReturnValue(new Promise((resolve) => (resolveSource = resolve)));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const id = store.openObjectSourceTabPending(pendingOptions({ name: "v_orders", objectType: "VIEW" }));

    // 请求还没回来，tab 已经在界面上：这正是 #9035 缺的那一步
    expect(store.tabs).toHaveLength(1);
    const tab = store.tabs[0]!;
    expect(tab.id).toBe(id);
    expect(tab.title).toBe("Source - v_orders");
    expect(tab.sourceView).toBe(true);
    expect(tab.sql).toBe("");
    expect(tab.objectSource).toBeUndefined();
    expect(tab.sourceLoad?.error).toBeUndefined();
    expect(tab.sourceLoad?.request).toEqual({ name: "v_orders", objectType: "VIEW", signature: undefined });
    expect(tab.sourceLoad?.startedAt).toBeTypeOf("number");

    resolveSource?.(objectSource("CREATE OR REPLACE VIEW app.v_orders AS SELECT 1 FROM dual"));
    await settle();
  });

  it("fills the same tab in place once the source resolves", async () => {
    mocks.getObjectSource.mockResolvedValue(objectSource("CREATE OR REPLACE VIEW app.v_orders AS SELECT 1 FROM dual"));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const id = store.openObjectSourceTabPending(pendingOptions({ name: "v_orders", objectType: "VIEW" }));
    await settle();

    expect(store.tabs).toHaveLength(1);
    const tab = store.tabs[0]!;
    expect(tab.id).toBe(id);
    expect(tab.sql).toBe("CREATE OR REPLACE VIEW app.v_orders AS SELECT 1 FROM dual");
    expect(tab.sourceView).toBe(true);
    expect(tab.sourceLoad).toBeUndefined();
    expect(tab.objectSource).toMatchObject({ schema: SCHEMA, name: "v_orders", objectType: "VIEW" });
  });

  it("keeps the resolved (fallback) object type on the tab, not the requested one", async () => {
    // 请求 PROCEDURE，后端返回空 → routine fallback 回落到 FUNCTION
    mocks.getObjectSource.mockImplementation(async (_connectionId, _database, _schema, _name, objectType: string) => objectSource(objectType === "FUNCTION" ? "CREATE OR REPLACE FUNCTION app.foo RETURN NUMBER IS BEGIN RETURN 1; END;" : ""));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    store.openObjectSourceTabPending(pendingOptions({ name: "foo", objectType: "PROCEDURE" }));
    await settle();

    expect(store.tabs[0]?.objectSource).toMatchObject({ name: "foo", objectType: "FUNCTION" });
  });

  it("surfaces a failure inside the tab and retries in place", async () => {
    mocks.getObjectSource.mockRejectedValueOnce(new Error("ORA-00942: table or view does not exist"));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const id = store.openObjectSourceTabPending(pendingOptions({ name: "v_orders", objectType: "VIEW" }));
    await settle();

    const failed = store.tabs[0]!;
    expect(failed.id).toBe(id);
    expect(failed.sourceLoad?.error).toContain("ORA-00942");
    expect(failed.sql).toBe("");
    // 失败不吞掉 tab：用户就在这个 tab 里重试，而不是只收到一个 toast

    mocks.getObjectSource.mockResolvedValueOnce(objectSource("CREATE OR REPLACE VIEW app.v_orders AS SELECT 2 FROM dual"));
    store.retryObjectSourceTab(id);
    // 重试立即回到加载态（错误清空 → tab 栏重新转圈）
    expect(store.tabs[0]?.sourceLoad?.error).toBeUndefined();
    await settle();

    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0]?.sql).toBe("CREATE OR REPLACE VIEW app.v_orders AS SELECT 2 FROM dual");
    expect(store.tabs[0]?.sourceLoad).toBeUndefined();
  });

  it("drops the result when the tab was closed while loading", async () => {
    let resolveSource: ((value: unknown) => void) | undefined;
    mocks.getObjectSource.mockReturnValue(new Promise((resolve) => (resolveSource = resolve)));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const id = store.openObjectSourceTabPending(pendingOptions({ name: "v_orders", objectType: "VIEW" }));
    store.closeTab(id);
    expect(store.tabs).toHaveLength(0);

    resolveSource?.(objectSource("CREATE OR REPLACE VIEW app.v_orders AS SELECT 1 FROM dual"));
    await settle();

    // 关掉就是放弃：不重建 tab、不写入已关闭的容器
    expect(store.tabs).toHaveLength(0);
  });

  it("reuses the pending tab and the in-flight request on a repeat click", async () => {
    let resolveSource: ((value: unknown) => void) | undefined;
    mocks.getObjectSource.mockReturnValue(new Promise((resolve) => (resolveSource = resolve)));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const options = pendingOptions({ name: "v_orders", objectType: "VIEW" });
    const first = store.openObjectSourceTabPending(options);
    const second = store.openObjectSourceTabPending(options);

    expect(second).toBe(first);
    expect(store.tabs).toHaveLength(1);

    // 第二次点击发生在请求真正发出之前（loader 先 await ensureConnected），
    // 所以这里要等微任务落定后再确认只发了一次请求
    await settle();
    expect(mocks.getObjectSource).toHaveBeenCalledTimes(1);

    resolveSource?.(objectSource("CREATE OR REPLACE VIEW app.v_orders AS SELECT 1 FROM dual"));
    await settle();
    expect(store.tabs).toHaveLength(1);
  });

  it("reuses an already loaded tab instantly and revalidates it in the background", async () => {
    mocks.getObjectSource.mockResolvedValue(objectSource("CREATE OR REPLACE VIEW app.v_orders AS SELECT 1 FROM dual"));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const options = pendingOptions({ name: "v_orders", objectType: "VIEW" });
    const first = store.openObjectSourceTabPending(options);
    await settle();
    expect(mocks.getObjectSource).toHaveBeenCalledTimes(1);
    expect(store.activeTabId).toBe(first);

    // 重复打开：不出现第二个转圈 tab，立刻回到同一个 tab，也不进加载态
    mocks.getObjectSource.mockResolvedValueOnce(objectSource("CREATE OR REPLACE VIEW app.v_orders AS SELECT 2 FROM dual"));
    expect(store.openObjectSourceTabPending(options)).toBe(first);
    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0]?.sourceLoad).toBeUndefined();
    // 复用路径不经过 ensureConnected，但树上动作的惯例仍是把该连接设为当前连接
    expect(mocks.connectionStore.activeConnectionId).toBe(CONNECTION_ID);

    await settle();
    // 后台重新校验：重开拿到的是最新 DDL（改动前每次打开都会重新取源，
    // 而源码 tab 没有别的刷新入口，所以复用不能省掉这次校验）
    expect(mocks.getObjectSource).toHaveBeenCalledTimes(2);
    expect(store.tabs[0]?.sql).toBe("CREATE OR REPLACE VIEW app.v_orders AS SELECT 2 FROM dual");
    expect(store.tabs[0]?.sourceLoad).toBeUndefined();
  });

  it("never clobbers unsaved edits when revalidating in the background", async () => {
    mocks.getObjectSource.mockResolvedValue(objectSource("CREATE OR REPLACE VIEW app.v_orders AS SELECT 1 FROM dual"));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const options = pendingOptions({ name: "v_orders", objectType: "VIEW" });
    const id = store.openObjectSourceTabPending(options);
    await settle();

    // 用户在源码 tab 里改了内容（未保存）
    store.updateSql(id, "CREATE OR REPLACE VIEW app.v_orders AS SELECT 999 FROM dual");

    mocks.getObjectSource.mockResolvedValueOnce(objectSource("CREATE OR REPLACE VIEW app.v_orders AS SELECT 2 FROM dual"));
    store.openObjectSourceTabPending(options);
    await settle();

    expect(store.tabs[0]?.sql).toContain("SELECT 999");
    expect(store.tabs[0]?.originalSql).not.toBe(store.tabs[0]?.sql);
  });

  it("hands the loaded source to an existing tab that already matches the resolved identity", async () => {
    // 已有一个解析为 FUNCTION 的 tab；本次请求的是 PROCEDURE（树的类型可能是错的），
    // 前置复用检查匹配不上，只能先开 pending，等 fallback 解析出 FUNCTION 后再交接。
    mocks.getObjectSource.mockImplementation(async (_connectionId, _database, _schema, _name, objectType: string) => objectSource(objectType === "FUNCTION" ? "CREATE OR REPLACE FUNCTION app.foo RETURN NUMBER IS BEGIN RETURN 1; END;" : ""));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const existingId = store.openObjectSourceTab({
      connectionId: CONNECTION_ID,
      database: DATABASE,
      title: "Source - foo",
      schema: SCHEMA,
      sql: "CREATE OR REPLACE FUNCTION app.foo RETURN NUMBER IS BEGIN RETURN 0; END;",
      objectSource: { schema: SCHEMA, name: "foo", objectType: "FUNCTION" },
    });

    const pendingId = store.openObjectSourceTabPending(pendingOptions({ name: "foo", objectType: "PROCEDURE" }));
    expect(store.tabs).toHaveLength(2);
    expect(pendingId).not.toBe(existingId);

    await settle();

    // pending 占位交接给既有 tab，不留下同一个对象的第二个 tab
    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0]?.id).toBe(existingId);
    expect(store.tabs[0]?.sql).toBe("CREATE OR REPLACE FUNCTION app.foo RETURN NUMBER IS BEGIN RETURN 1; END;");
    expect(store.tabs[0]?.sourceLoad).toBeUndefined();
  });

  it("honors backend editability: read-only sources load as a plain source tab", async () => {
    mocks.getObjectSource.mockResolvedValue(objectSource("CREATE SEQUENCE app.seq_users", false));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    store.openObjectSourceTabPending(pendingOptions({ name: "seq_users", objectType: "VIEW" }));
    await settle();

    const tab = store.tabs[0]!;
    expect(tab.sql).toBe("CREATE SEQUENCE app.seq_users");
    expect(tab.sourceView).toBe(true);
    expect(tab.objectSource).toBeUndefined();
    expect(tab.sourceLoad).toBeUndefined();
  });

  it("keeps a routine source tab saveable when opened from the view entry", async () => {
    // 侧栏单击/双击存储过程走的是「查看源码」(initialEditing=false)。该 tab 必须
    // 仍然挂着 objectSource，否则 Ctrl+S 会退化成「保存到 SQL 库」，用户再也改不了
    // 存储过程（v0.6.18 回归）。同一次「查看」也应复用同一个 tab。
    mocks.getObjectSource.mockResolvedValue(objectSource("CREATE OR REPLACE PROCEDURE app.sp_run AS BEGIN NULL; END;"));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const options = { ...pendingOptions({ name: "sp_run", objectType: "PROCEDURE" as const }), initialEditing: false };
    const id = store.openObjectSourceTabPending(options);
    await settle();

    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0]?.sql).toBe("CREATE OR REPLACE PROCEDURE app.sp_run AS BEGIN NULL; END;");
    expect(store.tabs[0]?.objectSource).toMatchObject({ schema: SCHEMA, name: "sp_run", objectType: "PROCEDURE" });

    expect(store.openObjectSourceTabPending(options)).toBe(id);
    await settle();
    expect(store.tabs).toHaveLength(1);
  });

  it("keeps OceanBase sequence CREATE source for viewing and uses ALTER only for editing", async () => {
    mocks.connectionStore.dbType = "oceanbase-oracle";
    mocks.getObjectSource.mockResolvedValue(objectSource('CREATE SEQUENCE "APP"."SEQ_USERS" START WITH 10 INCREMENT BY 2'));
    mocks.buildEditableObjectSource.mockResolvedValue('ALTER SEQUENCE "APP"."SEQ_USERS" INCREMENT BY 2');
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const base = pendingOptions({ name: "SEQ_USERS", objectType: "SEQUENCE" });

    store.openObjectSourceTabPending({ ...base, initialEditing: false });
    await settle();
    expect(store.tabs[0]?.sql).toContain("CREATE SEQUENCE");
    expect(store.tabs[0]?.sql).toContain("START WITH 10");
    expect(store.tabs[0]?.objectSource).toBeUndefined();

    store.openObjectSourceTabPending({ ...base, initialEditing: true });
    await settle();
    expect(store.tabs).toHaveLength(2);
    expect(store.tabs[1]?.sql).toBe('ALTER SEQUENCE "APP"."SEQ_USERS" INCREMENT BY 2');
    expect(store.tabs[1]?.objectSource).toMatchObject({ schema: SCHEMA, name: "SEQ_USERS", objectType: "SEQUENCE" });

    mocks.buildEditableObjectSource.mockResolvedValue('ALTER SEQUENCE "APP"."SEQ_USERS" INCREMENT BY 4');
    const editId = store.tabs[1]!.id;
    expect(store.openObjectSourceTabPending({ ...base, initialEditing: true })).toBe(editId);
    await settle();
    expect(store.tabs).toHaveLength(2);
    expect(store.tabs[1]?.sql).toBe('ALTER SEQUENCE "APP"."SEQ_USERS" INCREMENT BY 4');
  });
});
