// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QueryHistory from "../QueryHistory.vue";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  beginManualTransaction: vi.fn(),
  executeInManualTransaction: vi.fn(),
  commitManualTransaction: vi.fn(),
  rollbackManualTransaction: vi.fn(),
  executeScript: vi.fn(),
  guard: vi.fn(),
  toast: vi.fn(),
  close: vi.fn(),
  entry: {
    id: "history-1",
    connection_id: "ob-test",
    connection_name: "Transaction test",
    database: "SYS",
    sql: "UPDATE TEST_DATA SET VAL = 20 WHERE ID = 1",
    rollback_sql: "UPDATE TEST_DATA SET VAL = 10 WHERE ID = 1",
    execution_time_ms: 1,
    executed_at: "2026-01-01T00:00:00Z",
    success: true,
    activity_kind: "data_change",
    operation: "UPDATE",
    target: "TEST_DATA",
  },
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/historyStore", () => ({
  useHistoryStore: () => ({
    entries: [mocks.entry],
    connectionOptions: [],
    total: 1,
    loading: false,
    error: "",
    nextCursor: null,
    setHistoryPanelActive: vi.fn(),
    loadConnectionOptions: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue(undefined),
    add: mocks.add,
  }),
}));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: () => ({ id: "ob-test", db_type: "oceanbase-oracle" }) }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (text: string) => text }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionSqlGuard: mocks.guard }));
vi.mock("@/lib/backend/api", () => ({
  beginManualTransaction: mocks.beginManualTransaction,
  executeInManualTransaction: mocks.executeInManualTransaction,
  commitManualTransaction: mocks.commitManualTransaction,
  rollbackManualTransaction: mocks.rollbackManualTransaction,
  executeScript: mocks.executeScript,
}));
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: defineComponent({
    props: ["items"],
    setup:
      (props, { slots }) =>
      () =>
        h(
          "div",
          props.items.map((item: unknown) => slots.default?.({ item })),
        ),
  }),
}));
vi.mock("@/components/ui/CustomContextMenu.vue", () => ({
  default: defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.({ onContextMenu: vi.fn(), isOpen: false })),
  }),
}));

let app: App | undefined;
function button(key: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === key);
  if (!found) throw new Error(`Missing button ${key}`);
  return found;
}
async function openRollback(manual = true) {
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp(QueryHistory, { onClose: mocks.close });
  app.mount(root);
  await nextTick();
  const row = [...document.querySelectorAll<HTMLDivElement>("div")].find((item) => item.textContent?.includes(mocks.entry.sql) && item.classList.contains("cursor-pointer"));
  expect(row).toBeDefined();
  row!.click();
  await nextTick();
  await vi.waitFor(() => expect(button("history.rollback")).toBeDefined());
  if (manual) {
    const checkbox = [...document.querySelectorAll("label")].find((item) => item.textContent?.includes("toolbar.manualTransaction"))?.querySelector<HTMLInputElement>("input");
    expect(checkbox).toBeDefined();
    checkbox!.click();
    await nextTick();
  }
  button("history.rollback").click();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
  mocks.guard.mockImplementation((options) => options.execute());
  mocks.beginManualTransaction.mockResolvedValue("history-txn");
  mocks.executeInManualTransaction.mockResolvedValue([{ affected_rows: 1 }]);
  mocks.commitManualTransaction.mockResolvedValue({});
  mocks.rollbackManualTransaction.mockResolvedValue({});
  mocks.executeScript.mockResolvedValue({ affected_rows: 1 });
  mocks.add.mockResolvedValue(undefined);
});
afterEach(async () => {
  app?.unmount();
  app = undefined;
  await nextTick();
  document.body.textContent = "";
  vi.unstubAllGlobals();
});

describe("QueryHistory manual rollback SQL", () => {
  it("uses the selected history target and records success only after commit", async () => {
    await openRollback();
    await vi.waitFor(() => expect(button("toolbar.commit").disabled).toBe(false));
    expect(mocks.beginManualTransaction).toHaveBeenCalledWith("ob-test", "SYS");
    expect(mocks.executeInManualTransaction).toHaveBeenCalledWith("history-txn", mocks.entry.rollback_sql, "SYS");
    expect(mocks.executeScript).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalledWith("history.rollbackSuccess");
    button("toolbar.commit").click();
    await vi.waitFor(() => expect(mocks.add).toHaveBeenCalledWith(expect.objectContaining({ sql: mocks.entry.rollback_sql, affected_rows: 1, details_json: JSON.stringify({ rollback_of: "history-1" }) })));
    expect(mocks.commitManualTransaction).toHaveBeenCalledWith("history-txn");
  });

  it("discards the compensation without recording a successful rollback", async () => {
    await openRollback();
    await vi.waitFor(() => expect(button("history.discardRollback").disabled).toBe(false));
    button("history.discardRollback").click();
    await vi.waitFor(() => expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("history-txn"));
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.commitManualTransaction).not.toHaveBeenCalled();
  });

  it("rolls back a failed statement without falling back to ordinary execution", async () => {
    mocks.executeInManualTransaction.mockRejectedValueOnce(new Error("statement failed"));
    await openRollback();
    await vi.waitFor(() => expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("history-txn"));
    expect(mocks.executeScript).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("keeps transaction controls when commit fails and does not record success", async () => {
    mocks.commitManualTransaction.mockRejectedValueOnce(new Error("commit unavailable"));
    await openRollback();
    await vi.waitFor(() => expect(button("toolbar.commit").disabled).toBe(false));
    button("toolbar.commit").click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("commit unavailable", 5000));
    expect(button("history.discardRollback").disabled).toBe(false);
    expect(button("toolbar.commit").disabled).toBe(true);
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("does not claim successful compensation after an unknown commit outcome", async () => {
    mocks.commitManualTransaction.mockRejectedValueOnce(new Error("response lost"));
    await openRollback();
    await vi.waitFor(() => expect(button("toolbar.commit").disabled).toBe(false));
    button("toolbar.commit").click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("response lost", 5000));
    mocks.rollbackManualTransaction.mockRejectedValueOnce(new Error("Transaction session not found"));
    button("history.discardRollback").click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("toolbar.commitOutcomeUnknown", 5000));
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.commitManualTransaction).toHaveBeenCalledTimes(1);
  });

  it("cleans up a session returned after unmount without executing compensation", async () => {
    let resolve!: (session: string) => void;
    mocks.beginManualTransaction.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    await openRollback();
    await vi.waitFor(() => expect(mocks.beginManualTransaction).toHaveBeenCalledOnce());
    app!.unmount();
    app = undefined;
    resolve("late-history-txn");
    await vi.waitFor(() => expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("late-history-txn"));
    expect(mocks.executeInManualTransaction).not.toHaveBeenCalled();
  });

  it("does not create a transaction when the production guard declines", async () => {
    mocks.guard.mockResolvedValueOnce(undefined);
    await openRollback();
    await vi.waitFor(() => expect(mocks.guard).toHaveBeenCalledOnce());
    expect(mocks.beginManualTransaction).not.toHaveBeenCalled();
    expect(mocks.executeInManualTransaction).not.toHaveBeenCalled();
  });

  it("does not record success when the pending transaction has expired", async () => {
    mocks.commitManualTransaction.mockRejectedValueOnce(new Error("Transaction session not found"));
    await openRollback();
    await vi.waitFor(() => expect(button("toolbar.commit").disabled).toBe(false));
    button("toolbar.commit").click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("history.transactionEnded", 5000));
    expect(mocks.add).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("history.pendingRollback");
  });

  it("asks before discarding pending changes when closing history", async () => {
    await openRollback();
    await vi.waitFor(() => expect(button("toolbar.commit").disabled).toBe(false));
    const confirm = vi.mocked(window.confirm);
    confirm.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="common.close"]')!;
    close.click();
    await nextTick();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.rollbackManualTransaction).not.toHaveBeenCalled();
    close.click();
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(mocks.rollbackManualTransaction).toHaveBeenCalledWith("history-txn");
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("preserves ordinary execution when manual mode is not selected", async () => {
    await openRollback(false);
    await vi.waitFor(() => expect(mocks.add).toHaveBeenCalledOnce());
    expect(mocks.executeScript).toHaveBeenCalledWith("ob-test", "SYS", mocks.entry.rollback_sql);
    expect(mocks.beginManualTransaction).not.toHaveBeenCalled();
  });
});
