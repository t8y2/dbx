import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 从树上选中包成员打开的是包体，光标要落在那个子程序的实现上（DataGrip 行为）。
// 这批用例锁定定位契约：落到实现行、一次性消费、找不到就停在文件开头。
const mocks = vi.hoisted(() => {
  const connectionStore = {
    activeConnectionId: null as string | null,
    ensureConnected: vi.fn(async () => {}),
    dbType: "oracle",
    getConfig: (connectionId: string) => (connectionId ? { id: connectionId, name: connectionId, db_type: connectionStore.dbType } : undefined),
  };
  return {
    connectionStore,
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
const SCHEMA = "SCOTT";

const PACKAGE_BODY = `CREATE OR REPLACE PACKAGE BODY SCOTT.SALES_PKG AS
  PROCEDURE LOAD_FEEDS(VO IN SCOTT.ID_LIST_TYPE, IRET OUT VARCHAR2, SRET OUT VARCHAR2) IS
  BEGIN
    IRET := '0';
  END LOAD_FEEDS;

  PROCEDURE LOAD_SHIPMENTS(VO IN SCOTT.ID_LIST_TYPE, IRET OUT VARCHAR2, SRET OUT VARCHAR2) IS
  BEGIN
    IRET := '0';
  END LOAD_SHIPMENTS;
END SALES_PKG;`;

const memberOptions = (member: string) => ({
  connectionId: CONNECTION_ID,
  database: DATABASE,
  title: "Source - SALES_PKG",
  schema: SCHEMA,
  request: { name: "SALES_PKG", objectType: "PACKAGE_BODY" as const },
  focusMember: { name: member, kind: "procedure" as const, signature: "VO IN SCOTT.ID_LIST_TYPE, IRET OUT VARCHAR2, SRET OUT VARCHAR2" },
});

const packageBodySource = (source = PACKAGE_BODY) => ({ name: "SALES_PKG", object_type: "PACKAGE_BODY" as const, source });

/** 让 loader 的 await 链跑完（ensureConnected → getObjectSource → 落地）。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("queryStore package member reveal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
    setActivePinia(createPinia());
    mocks.connectionStore.dbType = "oracle";
  });

  it("puts the cursor on the member implementation once the package body lands", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    mocks.getObjectSource.mockResolvedValueOnce(packageBodySource());
    const id = store.openObjectSourceTabPending(memberOptions("LOAD_SHIPMENTS"));
    const tab = () => store.tabs.find((candidate) => candidate.id === id)!;
    expect(tab().objectSourceFocusMember).toEqual({ name: "LOAD_SHIPMENTS", kind: "procedure", signature: "VO IN SCOTT.ID_LIST_TYPE, IRET OUT VARCHAR2, SRET OUT VARCHAR2" });
    await settle();

    expect(tab().editorRevealRequest?.line).toBe(7);
    // 一次性消费：之后的刷新/重新挂载不再把光标从用户手里拽走。
    expect(tab().objectSourceFocusMember).toBeUndefined();
  });

  it("reuses the same package body tab and re-aims at the next member", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    mocks.getObjectSource.mockResolvedValue(packageBodySource());
    const id = store.openObjectSourceTabPending(memberOptions("LOAD_SHIPMENTS"));
    await settle();
    const first = store.tabs.find((candidate) => candidate.id === id)!.editorRevealRequest;
    expect(first?.line).toBe(7);

    expect(store.openObjectSourceTabPending(memberOptions("LOAD_FEEDS"))).toBe(id);
    const second = store.tabs.find((candidate) => candidate.id === id)!.editorRevealRequest;
    expect(second?.line).toBe(2);
    // 新的 reveal id：编辑器据此知道这是一次新的跳转，而不是同一个请求的重放。
    expect(second?.id).toBeGreaterThan(first!.id);
    expect(store.tabs.filter((candidate) => candidate.objectSource?.name === "SALES_PKG")).toHaveLength(1);
  });

  it("stays at the top of a spec-only package instead of guessing a line", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    mocks.getObjectSource.mockResolvedValueOnce(packageBodySource("CREATE OR REPLACE PACKAGE SCOTT.SALES_PKG AS\n  V_FLAG NUMBER;\nEND SALES_PKG;"));
    const id = store.openObjectSourceTabPending(memberOptions("LOAD_SHIPMENTS"));
    await settle();

    const tab = store.tabs.find((candidate) => candidate.id === id)!;
    expect(tab.editorRevealRequest).toBeUndefined();
    expect(tab.objectSourceFocusMember).toBeUndefined();
  });

  it("leaves ordinary object source tabs without a reveal request", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    mocks.getObjectSource.mockResolvedValueOnce(packageBodySource());
    const id = store.openObjectSourceTabPending({ connectionId: CONNECTION_ID, database: DATABASE, title: "Source - SALES_PKG", schema: SCHEMA, request: { name: "SALES_PKG", objectType: "PACKAGE_BODY" } });
    await settle();

    expect(store.tabs.find((candidate) => candidate.id === id)?.editorRevealRequest).toBeUndefined();
  });
});
