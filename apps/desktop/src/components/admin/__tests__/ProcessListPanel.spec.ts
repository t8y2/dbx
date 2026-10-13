// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App, type Component } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import { PG_PROCESS_LIST_SQL } from "@/lib/database/postgresProcessList";
import { XUGU_OWN_SESSION_SQL, XUGU_TRANSACTION_LIST_SQL } from "@/lib/database/xuguProcessList";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(),
  executeQuery: vi.fn(),
  executeMulti: vi.fn(),
  toast: vi.fn(),
}));

// Flipped by the driver mock to simulate engines without a terminate statement.
const driverState = vi.hoisted(() => ({ stripTerminate: false }));

function passthrough(tag: string): Component {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h(tag, attrs, slots.default?.());
    },
  });
}

function modelInput(): Component {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs }) {
      return () =>
        h("input", {
          ...attrs,
          value: attrs.modelValue as string,
          onInput: (event: Event) => (attrs["onUpdate:modelValue"] as ((value: string) => void) | undefined)?.((event.target as HTMLInputElement).value),
        });
    },
  });
}

function modelDialog(): Component {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => (attrs.open ? h("div", attrs, slots.default?.()) : null);
    },
  });
}

/** Dialog body mock carrying a marker so dialog-only buttons can be told apart from grid buttons. */
function dialogSurface(): Component {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h("div", { ...attrs, "data-dialog": "" }, slots.default?.());
    },
  });
}

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values === undefined ? key : `${key}:${Object.values(values).join(",")}`),
  }),
}));
vi.mock("@lucide/vue", () => {
  const Icon = passthrough("span");
  return { Activity: Icon, AlertTriangle: Icon, ArrowDown: Icon, ArrowUp: Icon, Ban: Icon, Copy: Icon, Loader2: Icon, PlugZap: Icon, RefreshCcw: Icon, Search: Icon };
});
vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("@/components/ui/badge", () => ({ Badge: passthrough("span") }));
vi.mock("@/components/ui/input", () => ({ Input: modelInput() }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: modelDialog(),
  DialogContent: dialogSurface(),
  DialogFooter: passthrough("div"),
  DialogHeader: passthrough("div"),
  DialogTitle: passthrough("div"),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ ensureConnected: mocks.ensureConnected }),
}));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/backend/api", () => ({ executeQuery: mocks.executeQuery, executeMulti: mocks.executeMulti }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({
  executeWithProductionSqlGuard: (options: { execute: () => Promise<unknown> }) => options.execute(),
}));
vi.mock("@/lib/tabs/tabUiState", () => ({ useTabUiState: () => ({ initialState: {}, track: () => {} }) }));
vi.mock("@/lib/database/processListDrivers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/database/processListDrivers")>();
  return {
    ...actual,
    resolveProcessListDriverForConnection: (connection: Parameters<typeof actual.resolveProcessListDriverForConnection>[0]) => {
      const resolved = actual.resolveProcessListDriverForConnection(connection);
      if (!resolved || !driverState.stripTerminate) return resolved;
      const { buildTerminateSessionSql: _omitted, ...rest } = resolved;
      return rest;
    },
  };
});

import ProcessListPanel from "@/components/admin/ProcessListPanel.vue";

const mysqlConnection: ConnectionConfig = {
  id: "mysql-1",
  name: "MySQL",
  db_type: "mysql",
  host: "localhost",
  port: 3306,
  username: "root",
  password: "",
};

const postgresConnection: ConnectionConfig = {
  id: "pg-1",
  name: "Postgres",
  db_type: "postgres",
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "",
};

const xuguConnection: ConnectionConfig = {
  id: "xugu-1",
  name: "Xugu",
  db_type: "xugu",
  database: "SHOP_DEMO",
  host: "localhost",
  port: 5138,
  username: "SYSDBA",
  password: "",
};

function xuguTransactionResult() {
  return {
    columns: ["NODE_ID", "TRANSACTION_ID", "SESSION_ID", "USER_NAME", "DB_NAME", "CLIENT_IP", "START_TIME"],
    rows: [
      [1, "100", 5, "SYSDBA", "SYSTEM", "127.0.0.1", "2026-09-30 10:00:00"],
      [2, "9007199254740993", 7, "APP_TEST", "SHOP_DEMO", "10.0.0.7", "2026-09-30 09:00:00"],
    ],
  };
}

function mysqlListResult() {
  return {
    columns: ["Id", "User", "Host", "db", "Command", "Time", "State", "Info"],
    rows: [
      [5, "root", "localhost", null, "Query", 0, "executing", "SHOW FULL PROCESSLIST"],
      [11, "app", "hosta", "shop", "Sleep", 120, null, null],
      [12, "app", "hostb", "shop", "Sleep", 30, null, null],
    ],
  };
}

function postgresListResult() {
  return {
    columns: ["pid", "user", "db", "client", "app", "state", "wait", "time", "query"],
    rows: [
      [5, "postgres", "postgres", "local", "", "active", "", 0, PG_PROCESS_LIST_SQL],
      [21, "app", "shop", "10.0.0.2", "worker", "idle", "", 120, "SELECT 1"],
      [22, "app", "shop", "10.0.0.3", "worker", "idle", "", 30, "SELECT 2"],
    ],
  };
}

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

beforeEach(() => {
  driverState.stripTerminate = false;
  mocks.ensureConnected.mockReset().mockResolvedValue(undefined);
  mocks.executeQuery.mockReset().mockImplementation(async (_connectionId: string, _database: string, sql: string) => {
    if (sql === "SELECT CONNECTION_ID()") return { columns: ["CONNECTION_ID()"], rows: [[5]] };
    if (sql === "SHOW FULL PROCESSLIST") return mysqlListResult();
    if (sql === "SELECT pg_backend_pid()") return { columns: ["pg_backend_pid"], rows: [[5]] };
    if (sql === PG_PROCESS_LIST_SQL) return postgresListResult();
    if (sql === XUGU_OWN_SESSION_SQL) return { columns: ["NODEID", "SESSION_ID"], rows: [[1, 5]] };
    if (sql === XUGU_TRANSACTION_LIST_SQL) return xuguTransactionResult();
    return { columns: [], rows: [] };
  });
  mocks.executeMulti.mockReset().mockResolvedValue([{ columns: [], rows: [] }]);
  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
  document.body.innerHTML = "";
});

function gridButtons(): HTMLButtonElement[] {
  return Array.from(root?.querySelectorAll("button") ?? []).filter((button) => !button.closest("[data-dialog]"));
}

function dialogButtons(): HTMLButtonElement[] {
  return Array.from(root?.querySelectorAll("[data-dialog] button") ?? []);
}

function findGridButton(prefix: string): HTMLButtonElement | undefined {
  return gridButtons().find((button) => button.textContent?.trim().startsWith(prefix));
}

function findDialogButton(text: string): HTMLButtonElement | undefined {
  return dialogButtons().find((button) => button.textContent?.trim() === text);
}

function sessionCheckbox(id: number): HTMLInputElement | undefined {
  return root?.querySelector<HTMLInputElement>(`[aria-label="processList.selectSession:${id}"]`) ?? undefined;
}

async function mountPanel(connection: ConnectionConfig) {
  app = createApp(ProcessListPanel, { connection });
  app.mount(root!);
  await vi.waitFor(() => expect(sessionCheckbox(11) ?? sessionCheckbox(21)).toBeTruthy());
  await vi.waitFor(() => expect((sessionCheckbox(11) ?? sessionCheckbox(21))?.disabled).toBe(false));
  await nextTick();
}

async function selectSessions(...ids: number[]) {
  for (const id of ids) {
    sessionCheckbox(id)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
  }
}

async function mountXuguPanel() {
  app = createApp(ProcessListPanel, { connection: xuguConnection });
  app.mount(root!);
  await vi.waitFor(() => expect(root?.textContent).toContain("9007199254740993"));
  await nextTick();
}

describe("ProcessListPanel batch terminate", () => {
  it("terminates every selected session one by one after confirmation", async () => {
    await mountPanel(mysqlConnection);
    await selectSessions(11, 12);

    const toolbarButton = findGridButton("processList.batchTerminate");
    expect(toolbarButton?.textContent).toContain("processList.batchTerminate:2");
    toolbarButton?.click();
    await nextTick();

    expect(root?.textContent).toContain("processList.batchTerminateTitle");
    expect(root?.textContent).toContain("processList.batchTerminateConfirm:2");
    expect(root?.textContent).toContain("11, 12");

    findDialogButton("processList.terminate")?.click();
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(2));
    expect(mocks.executeMulti).toHaveBeenNthCalledWith(1, "mysql-1", "", "KILL 11", undefined, undefined, { maxRows: 1 });
    expect(mocks.executeMulti).toHaveBeenNthCalledWith(2, "mysql-1", "", "KILL 12", undefined, undefined, { maxRows: 1 });

    await vi.waitFor(() => expect(root?.textContent).toContain("processList.batchTerminateSummary:2,0"));
    expect(findDialogButton("common.close")).toBeTruthy();
    // The selection is consumed so the same rows cannot be terminated twice.
    expect(findGridButton("processList.batchTerminate")?.disabled).toBe(true);
    expect(sessionCheckbox(11)?.checked).toBe(false);
    expect(sessionCheckbox(12)?.checked).toBe(false);
  });

  it("keeps terminating the remaining sessions and summarizes per-row failures", async () => {
    mocks.executeMulti.mockImplementation(async (_connectionId: string, _database: string, sql: string) => {
      if (sql === "KILL 11") return [{ columns: [], rows: [] }];
      throw new Error("Unknown thread id");
    });
    await mountPanel(mysqlConnection);
    await selectSessions(11, 12);

    findGridButton("processList.batchTerminate")?.click();
    await nextTick();
    findDialogButton("processList.terminate")?.click();

    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.batchTerminateSummary:1,1"));
    expect(root?.textContent).toContain("12: Unknown thread id");
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("locks the other batch and row actions while a batch termination is pending", async () => {
    const releaseTerminates: Array<() => void> = [];
    mocks.executeMulti.mockImplementation(() => new Promise((resolve) => releaseTerminates.push(() => resolve([{ columns: [], rows: [] }]))));
    await mountPanel(mysqlConnection);
    await selectSessions(11, 12);

    const batchCancelButton = findGridButton("processList.batchCancel");
    expect(batchCancelButton?.disabled).toBe(false);
    findGridButton("processList.batchTerminate")?.click();
    await nextTick();

    // The open confirmation dialog already locks the toolbar and row actions.
    expect(batchCancelButton?.disabled).toBe(true);
    expect(gridButtons().some((button) => button.textContent?.trim() === "processList.kill" && !button.disabled)).toBe(false);
    expect(gridButtons().some((button) => button.textContent?.trim() === "processList.terminate" && !button.disabled)).toBe(false);

    findDialogButton("processList.terminate")?.click();
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(1));
    expect(root?.textContent).toContain("processList.batchTerminateRunning");
    expect(batchCancelButton?.disabled).toBe(true);

    releaseTerminates.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(2));
    releaseTerminates.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.batchTerminateSummary:2,0"));
  });

  it("does not offer batch or row termination when the driver cannot terminate", async () => {
    driverState.stripTerminate = true;
    await mountPanel(mysqlConnection);

    expect(findGridButton("processList.batchTerminate")).toBeUndefined();
    expect(gridButtons().some((button) => button.textContent?.trim() === "processList.terminate")).toBe(false);
    // Query cancellation keeps multi-selection and its own batch action.
    expect(findGridButton("processList.batchCancel")).toBeTruthy();
    expect(sessionCheckbox(11)).toBeTruthy();
  });

  it("keeps the existing batch cancel flow working", async () => {
    await mountPanel(mysqlConnection);
    await selectSessions(11, 12);

    findGridButton("processList.batchCancel")?.click();
    await nextTick();
    expect(root?.textContent).toContain("processList.batchTitle");
    expect(root?.textContent).toContain("processList.batchConfirm:2");

    findDialogButton("processList.kill")?.click();
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(2));
    expect(mocks.executeMulti).toHaveBeenNthCalledWith(1, "mysql-1", "", "KILL QUERY 11", undefined, undefined, { maxRows: 1 });
    expect(mocks.executeMulti).toHaveBeenNthCalledWith(2, "mysql-1", "", "KILL QUERY 12", undefined, undefined, { maxRows: 1 });
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.batchSummary:2,0"));
  });

  it("enables selection and batch termination on engines without batch cancel", async () => {
    // PostgreSQL requires the server to confirm the termination with a true result cell.
    mocks.executeMulti.mockResolvedValue([{ columns: ["pg_terminate_backend"], rows: [[true]] }]);
    await mountPanel(postgresConnection);
    await selectSessions(21, 22);

    expect(findGridButton("processList.batchCancel")).toBeUndefined();
    const toolbarButton = findGridButton("processList.batchTerminate");
    expect(toolbarButton?.textContent).toContain("processList.batchTerminate:2");
    toolbarButton?.click();
    await nextTick();

    findDialogButton("processList.terminate")?.click();
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(2));
    expect(mocks.executeMulti).toHaveBeenNthCalledWith(1, "pg-1", "", "SELECT pg_terminate_backend(21)", undefined, undefined, { maxRows: 1 });
    expect(mocks.executeMulti).toHaveBeenNthCalledWith(2, "pg-1", "", "SELECT pg_terminate_backend(22)", undefined, undefined, { maxRows: 1 });
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.batchTerminateSummary:2,0"));
  });

  it("uses transaction labels and SYSTEM context without changing session controls", async () => {
    await mountXuguPanel();
    expect(root?.textContent).toContain("processList.transactionTitle");
    expect(root?.textContent).toContain("processList.transactionScope");
    expect(root?.textContent).toContain("processList.transactionCount:2");
    expect(root?.textContent).not.toContain("processList.terminate");
    expect(root?.querySelector("input[type=checkbox][aria-label^='processList.selectSession']")).toBeNull();
    expect(mocks.executeQuery).toHaveBeenCalledWith("xugu-1", "SYSTEM", XUGU_OWN_SESSION_SQL, undefined, undefined, { maxRows: 1 });
    expect(mocks.executeQuery).toHaveBeenCalledWith("xugu-1", "SYSTEM", XUGU_TRANSACTION_LIST_SQL, undefined, undefined, { maxRows: 5000 });
    const killButtons = gridButtons().filter((button) => button.textContent?.trim() === "processList.transactionKill");
    expect(killButtons).toHaveLength(2);
    expect(killButtons[0]?.disabled).toBe(true);
    expect(killButtons[1]?.disabled).toBe(false);

    killButtons[1]?.click();
    await nextTick();
    expect(root?.textContent).toContain("processList.transactionKillConfirm:9007199254740993,2,APP_TEST,SHOP_DEMO");
    findDialogButton("processList.transactionKill")?.click();
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledWith("xugu-1", "SYSTEM", "CALL DBMS_DBA.KILL_TRANS(2, 9007199254740993)", undefined, undefined, { maxRows: 1 }));
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("processList.transactionKillSuccess:9007199254740993", 2500));
  });

  it("does not query or offer termination if an old Xugu tab belongs to a non-SYSDBA login", async () => {
    app = createApp(ProcessListPanel, { connection: { ...xuguConnection, username: "DBX_7102_DBA" } });
    app.mount(root!);
    await nextTick();
    expect(root?.textContent).toContain("processList.transactionRequiresSysdba");
    expect(root?.textContent).not.toContain("processList.transactionCount");
    expect(gridButtons().filter((button) => button.textContent?.includes("processList.transactionKill"))).toHaveLength(0);
    expect(mocks.ensureConnected).not.toHaveBeenCalled();
    expect(mocks.executeQuery).not.toHaveBeenCalled();
  });

  it("keeps Xugu termination disabled when its own session cannot be identified", async () => {
    mocks.executeQuery.mockImplementation(async (_connectionId: string, _database: string, sql: string) => {
      if (sql === XUGU_OWN_SESSION_SQL) throw new Error("session unavailable");
      if (sql === XUGU_TRANSACTION_LIST_SQL) return xuguTransactionResult();
      return { columns: [], rows: [] };
    });
    await mountXuguPanel();
    expect(root?.textContent).toContain("processList.transactionNeedsSession");
    expect(
      gridButtons()
        .filter((button) => button.textContent?.trim() === "processList.transactionKill")
        .every((button) => button.disabled),
    ).toBe(true);
  });

  it("rechecks the Xugu session before killing when the connection changed during confirmation", async () => {
    await mountXuguPanel();
    gridButtons()
      .filter((button) => button.textContent?.trim() === "processList.transactionKill")[1]
      ?.click();
    await nextTick();
    mocks.executeQuery.mockImplementation(async (_connectionId: string, _database: string, sql: string) => {
      if (sql === XUGU_OWN_SESSION_SQL) return { columns: ["NODEID", "SESSION_ID"], rows: [[2, 7]] };
      if (sql === XUGU_TRANSACTION_LIST_SQL) return xuguTransactionResult();
      return { columns: [], rows: [] };
    });
    findDialogButton("processList.transactionKill")?.click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("processList.transactionKillFailed:processList.transactionCannotKillSelf", 5000));
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it("explains failed Xugu SYSDBA reads without exposing a termination action", async () => {
    mocks.executeQuery.mockImplementation(async (_connectionId: string, _database: string, sql: string) => {
      if (sql === XUGU_OWN_SESSION_SQL) return { columns: ["NODEID", "SESSION_ID"], rows: [[1, 5]] };
      if (sql === XUGU_TRANSACTION_LIST_SQL) throw new Error("E18012: permission denied");
      return { columns: [], rows: [] };
    });
    app = createApp(ProcessListPanel, { connection: xuguConnection });
    app.mount(root!);
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.transactionLoadFailed:E18012: permission denied"));
    expect(gridButtons().filter((button) => button.textContent?.trim() === "processList.transactionKill")).toHaveLength(0);
    expect(root?.textContent).not.toContain("processList.transactionEmpty");
    expect(root?.textContent).not.toContain("processList.transactionCount:0");
  });

  it("clears stale Xugu kill targets after a connection failure on refresh", async () => {
    await mountXuguPanel();
    expect(gridButtons().filter((button) => button.textContent?.trim() === "processList.transactionKill")).toHaveLength(2);
    mocks.executeQuery.mockImplementation(async (_connectionId: string, _database: string, sql: string) => {
      if (sql === XUGU_TRANSACTION_LIST_SQL) throw new Error("connection reset by peer");
      return { columns: ["NODEID", "SESSION_ID"], rows: [[1, 5]] };
    });
    findGridButton("grid.refresh")?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.transactionLoadFailed:connection reset by peer"));
    expect(gridButtons().filter((button) => button.textContent?.trim() === "processList.transactionKill")).toHaveLength(0);
    expect(root?.textContent).not.toContain("processList.transactionEmpty");
    expect(root?.textContent).not.toContain("processList.transactionCount:0");
  });
});
