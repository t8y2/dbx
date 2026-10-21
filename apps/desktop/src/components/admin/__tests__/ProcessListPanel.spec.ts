// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App, type Component } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import zhCN from "@/i18n/locales/zh-CN";
import { PG_PROCESS_LIST_SQL } from "@/lib/database/postgresProcessList";
import { XUGU_OWN_SESSION_SQL, XUGU_TRANSACTION_LIST_SQL } from "@/lib/database/xuguProcessList";
import { buildOceanbaseSessionListSql, OCEANBASE_OWN_SESSION_SQL, buildOracleOwnSessionSql, buildOracleSessionListSql, ORACLE_SESSION_VERSION_SQL } from "@/lib/database/oracleSessionManagement";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(),
  executeQuery: vi.fn(),
  executeMulti: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  contextGuard: vi.fn(),
  contextGuardGate: null as null | (() => Promise<void>),
  toast: vi.fn(),
  oceanbaseRows: [] as unknown[][],
  oceanbaseTerminated: false,
  oceanbaseKeepTerminatedRow: false,
  oceanbaseListFailure: "",
  oceanbaseListTruncated: false,
  oceanbaseLockFailure: "",
  oceanbaseLockRows: [] as unknown[][],
  oceanbaseLockTruncated: false,
  oceanbaseLockGate: null as null | (() => Promise<void>),
  oceanbaseTerminateFailure: "",
  oceanbaseTargetChanged: false,
  oracleVersionValue: "19.0.0.0.0",
  oracleVersionFailure: "",
  oracleVersionGate: null as null | (() => Promise<void>),
  oracleListFailure: "",
  oracleTargetChanged: false,
  oracleTargetMissing: false,
  localeMessages: null as Record<string, unknown> | null,
  executionErrorSql: "",
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
    t: (key: string, values?: Record<string, unknown>) => {
      const message = mocks.localeMessages?.[key.split(".")[0]!] as Record<string, unknown> | undefined;
      const resolved = key
        .split(".")
        .slice(1)
        .reduce<unknown>((current, part) => (current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined), message);
      if (typeof resolved !== "string") return values === undefined ? key : `${key}:${Object.values(values).join(",")}`;
      return Object.entries(values ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), resolved);
    },
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
vi.mock("@/lib/backend/api", () => ({ executeQuery: mocks.executeQuery, executeMulti: mocks.executeMulti, closeClientConnectionSession: mocks.closeClientConnectionSession }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({
  executeWithProductionSqlGuard: (options: { execute: () => Promise<unknown> }) => options.execute(),
  executeWithProductionContextGuard: async (options: { execute: () => Promise<unknown> }) => {
    mocks.contextGuard(options);
    if (mocks.contextGuardGate) await mocks.contextGuardGate();
    return options.execute();
  },
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

const oracleConnection: ConnectionConfig = {
  id: "oracle-1",
  name: "Oracle",
  db_type: "oracle",
  host: "localhost",
  port: 1521,
  username: "APP",
  password: "",
};

const oceanbaseConnection: ConnectionConfig = {
  id: "oceanbase-1",
  name: "OceanBase",
  db_type: "oceanbase-oracle",
  host: "localhost",
  port: 2881,
  username: "APP",
  password: "",
};

let oracleTerminated = false;
let oracleTerminateError = "";
function oracleListResult() {
  const rows: unknown[][] = [["5", "30", "1", "3", "APP", "ACTIVE", "localhost", "DBX", "selfsql", null, null, null, "500", "2026-10-20 09:00:00"]];
  if (!oracleTerminated) rows.push(["21", "42", "2", "3", "OTHER", "INACTIVE", "apphost", "worker", null, "SQL*Net message from client", null, null, "700", "2026-10-20 08:00:00"]);
  return { columns: [], rows };
}

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
    if (mocks.executionErrorSql && sql.includes(mocks.executionErrorSql)) return { columns: ["Error"], rows: [["legacy error row"]], execution_error: true, error: { detail: "ORA-01031: managed read denied" } };
    if (sql === "SELECT CONNECTION_ID()") return { columns: ["CONNECTION_ID()"], rows: [[5]] };
    if (sql === "SHOW FULL PROCESSLIST") return mysqlListResult();
    if (sql === "SELECT pg_backend_pid()") return { columns: ["pg_backend_pid"], rows: [[5]] };
    if (sql === PG_PROCESS_LIST_SQL) return postgresListResult();
    if (sql === XUGU_OWN_SESSION_SQL) return { columns: ["NODEID", "SESSION_ID"], rows: [[1, 5]] };
    if (sql === XUGU_TRANSACTION_LIST_SQL) return xuguTransactionResult();
    if (sql === ORACLE_SESSION_VERSION_SQL) {
      const failure = mocks.oracleVersionFailure;
      const value = mocks.oracleVersionValue;
      const gate = mocks.oracleVersionGate;
      mocks.oracleVersionGate = null;
      if (gate) await gate();
      if (failure) throw new Error(failure);
      return { columns: ["VERSION"], rows: [[value]] };
    }
    if (sql === buildOracleOwnSessionSql(false) || sql === buildOracleOwnSessionSql(true)) return { columns: [], rows: [["5", "1", "3"]] };
    if (sql === buildOracleSessionListSql(false) || sql === buildOracleSessionListSql(true)) {
      if (mocks.oracleListFailure) throw new Error(mocks.oracleListFailure);
      return oracleListResult();
    }
    if (sql.includes("FROM GV$LOCK l JOIN GV$SESSION s"))
      return { columns: ["CONTAINER_ID", "INSTANCE_ID", "SESSION_ID", "LOCK_TYPE", "ID1", "ID2", "HELD_MODE", "REQUESTED_MODE", "BLOCKING", "SESSION_USER", "SESSION_STATUS", "BLOCKER"], rows: [["3", "2", "21", "TX", "100", "200", "6", "0", "1", "OTHER", "INACTIVE", "—"]] };
    if (sql.includes("ALTER SYSTEM KILL SESSION")) {
      if (oracleTerminateError) throw new Error(oracleTerminateError);
      if (mocks.oracleTargetMissing) throw new Error("ORA-20002: Session identity changed; target no longer exists");
      if (mocks.oracleTargetChanged) throw new Error("ORA-20002: Session identity changed; refresh the list");
      oracleTerminated = true;
      return { columns: [], rows: [] };
    }
    if (sql === OCEANBASE_OWN_SESSION_SQL) return { columns: ["ID", "USER", "TENANT"], rows: [["5", "APP", "tenant_a"]] };
    if (sql === buildOceanbaseSessionListSql()) {
      if (mocks.oceanbaseListFailure) throw new Error(mocks.oceanbaseListFailure);
      return { columns: [], rows: mocks.oceanbaseTerminated && !mocks.oceanbaseKeepTerminatedRow ? mocks.oceanbaseRows.filter((row) => String(row[0]) !== "21") : mocks.oceanbaseRows, truncated: mocks.oceanbaseListTruncated };
    }
    if (sql.includes("FROM GV$OB_LOCKS l")) {
      if (mocks.oceanbaseLockFailure) throw new Error(mocks.oceanbaseLockFailure);
      const rows = mocks.oceanbaseLockRows;
      const gate = mocks.oceanbaseLockGate;
      mocks.oceanbaseLockGate = null;
      if (gate) await gate();
      return {
        columns: ["SERVER_IP", "SERVER_PORT", "TENANT_ID", "TRANS_ID", "SESSION_ID", "TYPE", "ID1", "ID2", "ID3", "LMODE", "REQUEST", "CTIME", "BLOCK", "SESSION_USER", "SESSION_STATE"],
        rows,
        truncated: mocks.oceanbaseLockTruncated,
      };
    }
    if (sql.includes("EXECUTE IMMEDIATE 'KILL CONNECTION")) {
      if (mocks.oceanbaseTerminateFailure) throw new Error(mocks.oceanbaseTerminateFailure);
      if (mocks.oceanbaseTargetChanged) throw new Error("ORA-20001: Session identity changed or is not directly addressable");
      mocks.oceanbaseTerminated = true;
      return { columns: [], rows: [] };
    }
    return { columns: [], rows: [] };
  });
  mocks.executeMulti.mockReset().mockResolvedValue([{ columns: [], rows: [] }]);
  mocks.closeClientConnectionSession.mockReset().mockResolvedValue(undefined);
  mocks.contextGuard.mockReset();
  mocks.contextGuardGate = null;
  mocks.toast.mockReset();
  oracleTerminated = false;
  oracleTerminateError = "";
  mocks.oceanbaseRows = [
    ["5", "APP", "tenant_a", "localhost", "db", "Query", "0", "active", "SELECT 1", null, "127.0.0.1", "2882"],
    ["21", "OTHER", "tenant_a", "apphost", "db", "Sleep", "4", "idle", "SELECT 2", null, "127.0.0.1", "2882"],
    ["22", "PROXY", "tenant_a", "proxyhost", "db", "Query", "5", "active", "SELECT 3", "99", "127.0.0.2", "2882"],
  ];
  mocks.oceanbaseTerminated = false;
  mocks.oceanbaseKeepTerminatedRow = false;
  mocks.oceanbaseListFailure = "";
  mocks.oceanbaseListTruncated = false;
  mocks.oceanbaseLockFailure = "";
  mocks.oceanbaseLockRows = [["127.0.0.1", "2882", "7", "900", "21", "TX", "100", "200", "300", "6", "0", "10", "1", "OTHER", "WAITING"]];
  mocks.oceanbaseLockTruncated = false;
  mocks.oceanbaseLockGate = null;
  mocks.oceanbaseTerminateFailure = "";
  mocks.oceanbaseTargetChanged = false;
  mocks.oracleVersionValue = "19.0.0.0.0";
  mocks.oracleVersionFailure = "";
  mocks.oracleVersionGate = null;
  mocks.oracleListFailure = "";
  mocks.oracleTargetChanged = false;
  mocks.oracleTargetMissing = false;
  mocks.localeMessages = null;
  mocks.executionErrorSql = "";
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

async function mountOceanbasePanel() {
  app = createApp(ProcessListPanel, { connection: oceanbaseConnection });
  app.mount(root!);
  await vi.waitFor(() => expect(root?.querySelector("tbody")?.textContent).toContain("21"));
  await nextTick();
}

async function mountOraclePanel() {
  app = createApp(ProcessListPanel, { connection: oracleConnection });
  app.mount(root!);
  await vi.waitFor(() => expect(root?.querySelector("tbody")?.textContent).toContain("21"));
  await nextTick();
}

async function mountReactivePanel(connection: ConnectionConfig) {
  const reactiveConnection = reactive({ ...connection });
  const Wrapper = defineComponent({ setup: () => () => h(ProcessListPanel, { connection: reactiveConnection }) });
  app = createApp(Wrapper);
  app.mount(root!);
  await vi.waitFor(() => expect(root?.textContent).toContain("21"));
  await nextTick();
  return reactiveConnection;
}

function processRow(id: string): HTMLTableRowElement {
  const row = [...(root?.querySelectorAll<HTMLTableRowElement>("tbody tr") ?? [])].find((candidate) => candidate.querySelector("td")?.textContent?.trim().match(/^\d+/)?.[0] === id);
  expect(row, `session row ${id}`).toBeDefined();
  return row!;
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
  it.each([
    ["Oracle", oracleConnection, buildOracleSessionListSql(false)],
    ["OceanBase Oracle", oceanbaseConnection, buildOceanbaseSessionListSql()],
  ])("reports a resolved execution error from the %s session list instead of an empty result", async (_label, connection, sql) => {
    mocks.executionErrorSql = sql;
    app = createApp(ProcessListPanel, { connection });
    app.mount(root!);
    await vi.waitFor(() => expect(root?.textContent).toContain("ORA-01031: managed read denied"));
    expect(root?.textContent).not.toContain("processList.empty");
    expect(root?.querySelector("tbody")?.textContent).not.toContain("legacy error row");
  });

  it.each([
    ["Oracle", oracleConnection, "FROM GV$LOCK l JOIN GV$SESSION s"],
    ["OceanBase Oracle", oceanbaseConnection, "FROM GV$OB_LOCKS l"],
  ])("reports a resolved execution error from %s lock details without rendering it as a lock", async (_label, connection, sql) => {
    if (connection.db_type === "oracle") await mountOraclePanel();
    else await mountOceanbasePanel();
    mocks.executionErrorSql = sql;
    processRow("21").querySelector<HTMLButtonElement>('button[title="processList.oracleLockDetails"]')?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("ORA-01031: managed read denied"));
    expect(root?.textContent).not.toContain("processList.oracleLockDetailsEmpty");
    expect(root?.querySelector("[data-dialog]")?.textContent).not.toContain("legacy error row");
    expect(processRow("21").textContent).toContain("OTHER");
  });

  it("uses the CON_ID-scoped Oracle query when version detection is unknown or denied", async () => {
    mocks.oracleVersionValue = "Oracle Database 19c";
    app = createApp(ProcessListPanel, { connection: oracleConnection });
    app.mount(root!);
    await vi.waitFor(() => expect(root?.querySelector("tbody")?.textContent).toContain("21"));
    expect(root?.textContent).toContain("processList.oracleVersionUnknown");
    expect(mocks.executeQuery.mock.calls.some((call) => call[2] === buildOracleSessionListSql(false))).toBe(true);
    expect(mocks.executeQuery.mock.calls.some((call) => call[2] === buildOracleOwnSessionSql(false))).toBe(true);
    expect(mocks.executeQuery.mock.calls.some((call) => call[2] === buildOracleSessionListSql(true))).toBe(false);
    expect(mocks.executeQuery.mock.calls.some((call) => call[2] === buildOracleOwnSessionSql(true))).toBe(false);

    app.unmount();
    app = null;
    root!.innerHTML = "";
    mocks.executeQuery.mockClear();
    mocks.oracleVersionFailure = "ORA-01031: insufficient privileges";
    await mountOraclePanel();
    expect(root?.textContent).toContain("ORA-01031: insufficient privileges");
    expect(mocks.executeQuery.mock.calls.some((call) => call[2] === buildOracleSessionListSql(false))).toBe(true);
    expect(mocks.executeQuery.mock.calls.some((call) => call[2] === buildOracleOwnSessionSql(false))).toBe(true);
    expect(mocks.executeQuery.mock.calls.some((call) => call[2] === buildOracleSessionListSql(true))).toBe(false);
    expect(mocks.executeQuery.mock.calls.some((call) => call[2] === buildOracleOwnSessionSql(true))).toBe(false);

    app?.unmount();
    app = null;
    root!.innerHTML = "";
    mocks.executeQuery.mockClear();
    mocks.oracleListFailure = "ORA-00904: CON_ID invalid identifier";
    app = createApp(ProcessListPanel, { connection: oracleConnection });
    app.mount(root!);
    await vi.waitFor(() => expect(root?.textContent).toContain("ORA-00904: CON_ID invalid identifier"));
    expect(root?.textContent).toContain("ORA-01031: insufficient privileges");
    expect(root?.textContent).not.toContain("processList.empty");
    expect(mocks.executeQuery.mock.calls.some((call) => call[2] === buildOracleSessionListSql(false))).toBe(true);
    expect(mocks.executeQuery.mock.calls.some((call) => call[2] === buildOracleSessionListSql(true))).toBe(false);
  });

  it("uses the legacy Oracle query only after explicitly detecting a pre-12c version", async () => {
    mocks.oracleVersionValue = "11.2.0.4.0";
    await mountOraclePanel();
    expect(mocks.executeQuery.mock.calls.some((call) => call[2] === buildOracleSessionListSql(true))).toBe(true);
    expect(mocks.executeQuery.mock.calls.some((call) => call[2] === buildOracleOwnSessionSql(true))).toBe(true);
    expect(mocks.executeQuery.mock.calls.some((call) => call[2] === buildOracleSessionListSql(false))).toBe(false);
  });

  it.each([
    ["late 11g result", "11.2.0.4.0", ""],
    ["late probe rejection", "19.0.0.0.0", "ORA-01031: stale probe denied"],
  ])("discards %s after the Oracle connection changes", async (_label, oldVersion, oldFailure) => {
    let releaseProbe!: () => void;
    mocks.oracleVersionValue = oldVersion;
    mocks.oracleVersionFailure = oldFailure;
    mocks.oracleVersionGate = () => new Promise<void>((resolve) => (releaseProbe = resolve));
    const liveConnection = reactive({ ...oracleConnection });
    const Wrapper = defineComponent({ setup: () => () => h(ProcessListPanel, { connection: liveConnection }) });
    app = createApp(Wrapper);
    app.mount(root!);
    await vi.waitFor(() => expect(mocks.executeQuery.mock.calls.some((call) => call[2] === ORACLE_SESSION_VERSION_SQL)).toBe(true));

    liveConnection.host = "replacement-host";
    mocks.oracleVersionValue = "19.0.0.0.0";
    mocks.oracleVersionFailure = "";
    await nextTick();
    releaseProbe();

    await vi.waitFor(() => expect(mocks.executeQuery.mock.calls.some((call) => call[2] === buildOracleSessionListSql(false))).toBe(true));
    expect(mocks.executeQuery.mock.calls.filter((call) => call[2] === ORACLE_SESSION_VERSION_SQL)).toHaveLength(2);
    expect(mocks.executeQuery.mock.calls.some((call) => call[2] === buildOracleSessionListSql(true))).toBe(false);
    expect(mocks.executeQuery.mock.calls.some((call) => call[2] === buildOracleOwnSessionSql(true))).toBe(false);
    expect(root?.textContent).not.toContain("ORA-01031: stale probe denied");
  });

  it("rejects a changed Oracle target identity and never reports it as terminated", async () => {
    await mountOraclePanel();
    const targetRow = processRow("21");
    targetRow.querySelector<HTMLButtonElement>('button[title="processList.terminate"]')?.click();
    await nextTick();
    mocks.oracleTargetChanged = true;
    findDialogButton("processList.terminate")?.click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("ORA-20002: Session identity changed"), 5000));
    const sql = mocks.executeQuery.mock.calls.map((call) => String(call[2])).find((statement) => statement.includes("ALTER SYSTEM KILL SESSION"));
    expect(sql).toContain("SID = 21 AND SERIAL# = 42 AND INST_ID = 2 AND CON_ID = 3");
    expect(sql).toContain("AUDSID = 700");
    expect(oracleTerminated).toBe(false);
    expect(mocks.toast).not.toHaveBeenCalledWith("processList.terminateSuccess:21", 2500);
  });

  it("does not report a vanished Oracle session as terminated", async () => {
    await mountOraclePanel();
    processRow("21").querySelector<HTMLButtonElement>('button[title="processList.terminate"]')?.click();
    await nextTick();
    mocks.oracleTargetMissing = true;
    findDialogButton("processList.terminate")?.click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("target no longer exists"), 5000));
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).includes("ALTER SYSTEM KILL SESSION"))).toBe(true);
    expect(oracleTerminated).toBe(false);
    expect(mocks.toast).not.toHaveBeenCalledWith("processList.terminateSuccess:21", 2500);
  });

  it("does not submit a confirmed Oracle termination after same-ID connection configuration changes", async () => {
    const liveConnection = await mountReactivePanel(oracleConnection);
    processRow("21").querySelector<HTMLButtonElement>('button[title="processList.terminate"]')?.click();
    await nextTick();
    liveConnection.host = "replacement-host";
    await nextTick();
    expect(findDialogButton("processList.terminate")).toBeUndefined();
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).includes("ALTER SYSTEM KILL SESSION"))).toBe(false);
  });

  it("renders the terminate action from the actual zh-CN message table", async () => {
    mocks.localeMessages = zhCN as Record<string, unknown>;
    await mountReactivePanel(oracleConnection);
    processRow("21").querySelector<HTMLButtonElement>('button[title="终止会话"]')?.click();
    await nextTick();
    expect(findDialogButton("终止会话")).toBeDefined();
    expect(mocks.contextGuard).not.toHaveBeenCalled();
  });

  it("consumes OceanBase sessions and locks, filters and refreshes rows, and terminates one supported session", async () => {
    mocks.oceanbaseListTruncated = true;
    await mountOceanbasePanel();
    expect(root?.textContent).toContain("processList.sessionCount:3+");
    const filter = root?.querySelector<HTMLInputElement>('input[placeholder="processList.filter"]');
    expect(filter).toBeDefined();
    filter!.value = "OTHER";
    filter!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(processRow("21").textContent).toContain("OTHER");
    expect(root?.querySelectorAll("tbody tr")).toHaveLength(1);
    filter!.value = "";
    filter!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    processRow("21").querySelector<HTMLButtonElement>('button[title="processList.oracleLockDetails"]')?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("TX"));
    expect(root?.textContent).toContain("processList.oracleLockTarget");
    const lockCall = mocks.executeQuery.mock.calls.find((call) => String(call[2]).includes("FROM GV$OB_LOCKS"));
    expect(lockCall?.[5]).toMatchObject({ clientSessionId: expect.stringMatching(/^process-list:/) });

    const sessionIds = mocks.executeQuery.mock.calls.map((call) => (call[5] as { clientSessionId?: string } | undefined)?.clientSessionId);
    expect(new Set(sessionIds).size).toBe(1);
    const queryCount = mocks.executeQuery.mock.calls.filter((call) => call[2] === buildOceanbaseSessionListSql()).length;
    mocks.oceanbaseRows[1]![1] = "UPDATED";
    gridButtons()
      .find((button) => button.textContent?.trim() === "grid.refresh")
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("UPDATED"));
    expect(mocks.executeQuery.mock.calls.filter((call) => call[2] === buildOceanbaseSessionListSql()).length).toBeGreaterThan(queryCount);

    const proxyTerminate = processRow("22").querySelector<HTMLButtonElement>('button[title="processList.oracleProxyUnsupported"]');
    expect(proxyTerminate?.disabled).toBe(true);
    expect(processRow("5").querySelector<HTMLButtonElement>('button[title="processList.cannotTerminateSelf"]')?.disabled).toBe(true);
    processRow("21").querySelector<HTMLButtonElement>('button[title="processList.terminate"]')?.click();
    await nextTick();
    expect(root?.textContent).toContain("processList.oracleTenant");
    expect(root?.textContent).toContain("processList.oracleNode");
    findDialogButton("processList.terminate")?.click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("processList.oracleTerminateUnknown", 5000));
    const killCall = mocks.executeQuery.mock.calls.find((call) => String(call[2]).includes("EXECUTE IMMEDIATE 'KILL CONNECTION"));
    expect(killCall?.[2]).toContain(`ID = 21 AND "USER" = 'UPDATED' AND TENANT = 'tenant_a'`);
    expect(killCall?.[5]).toMatchObject({ clientSessionId: expect.stringMatching(/^process-list:/) });
    expect(mocks.contextGuard.mock.calls.at(-1)?.[0]).toMatchObject({ scope: "connection", reviewText: expect.stringContaining("KILL CONNECTION") });
    const managementSessionId = sessionIds[0];
    app?.unmount();
    app = null;
    expect(mocks.closeClientConnectionSession).toHaveBeenCalledWith(oceanbaseConnection.id, "", managementSessionId);
  });

  it("renders OceanBase lock labels from the actual zh-CN message table", async () => {
    mocks.localeMessages = zhCN as Record<string, unknown>;
    mocks.oceanbaseLockTruncated = true;
    await mountOceanbasePanel();
    const lockButton = processRow("21").querySelector<HTMLButtonElement>('button[title="锁详情"]');
    expect(lockButton?.textContent).toContain("锁详情");
    lockButton?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("目标会话：OTHER ·"));
    expect(root?.textContent).toContain("锁记录已截断；显示结果可能不完整。");
    expect(root?.textContent).not.toContain("processList.oracleLockDetails");
  });

  it("renders the OceanBase empty lock message from the actual zh-CN table", async () => {
    mocks.localeMessages = zhCN as Record<string, unknown>;
    mocks.oceanbaseLockRows = [];
    await mountOceanbasePanel();
    processRow("21").querySelector<HTMLButtonElement>('button[title="锁详情"]')?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("此会话没有可见的锁记录。"));
  });

  it("clears a closed lock request and ignores its late response after reopening", async () => {
    let release!: () => void;
    mocks.oceanbaseLockRows = [["127.0.0.1", "2882", "7", "900", "21", "TX", "100", "200", "300", "6", "0", "10", "1", "OLD", "WAITING"]];
    mocks.oceanbaseLockGate = () => new Promise<void>((resolve) => (release = resolve));
    await mountOceanbasePanel();
    const lockButton = processRow("21").querySelector<HTMLButtonElement>('button[title="processList.oracleLockDetails"]')!;
    lockButton.click();
    await vi.waitFor(() => expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM GV$OB_LOCKS l")).length).toBe(1));
    root?.querySelector<HTMLButtonElement>("[data-dialog] button")?.click();
    await nextTick();
    expect(lockButton.disabled).toBe(false);

    mocks.oceanbaseLockRows = [["127.0.0.1", "2882", "7", "901", "21", "TX", "101", "201", "301", "6", "0", "10", "1", "FRESH", "WAITING"]];
    lockButton.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("FRESH"));
    release();
    await nextTick();
    expect(root?.textContent).toContain("FRESH");
    expect(root?.textContent).not.toContain("OLD");
  });

  it("does not report termination success when the truncated refresh omits the target", async () => {
    mocks.localeMessages = zhCN as Record<string, unknown>;
    mocks.oceanbaseListTruncated = true;
    await mountOceanbasePanel();
    processRow("21").querySelector<HTMLButtonElement>('button[title="终止会话"]')?.click();
    await nextTick();
    findDialogButton("终止会话")?.click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("终止请求结果不明。请刷新会话列表确认状态，不要重复提交。", 5000));
    expect(mocks.toast).not.toHaveBeenCalledWith("processList.terminateSuccess:21", 2500);
  });

  it("uses the existing pending message when the terminated row remains in the refreshed list", async () => {
    mocks.localeMessages = zhCN as Record<string, unknown>;
    mocks.oceanbaseKeepTerminatedRow = true;
    await mountOceanbasePanel();
    processRow("21").querySelector<HTMLButtonElement>('button[title="终止会话"]')?.click();
    await nextTick();
    findDialogButton("终止会话")?.click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("终止请求已接受，会话仍在回滚或尚未退出。刷新以查看状态。", 4000));
  });

  it("keeps an OceanBase list permission failure distinct from confirmed empty results", async () => {
    mocks.oceanbaseListFailure = "ORA-01031: process list denied";
    app = createApp(ProcessListPanel, { connection: oceanbaseConnection });
    app.mount(root!);
    await vi.waitFor(() => expect(root?.textContent).toContain("ORA-01031: process list denied"));
    expect(root?.textContent).not.toContain("processList.empty");
  });

  it("preserves the OceanBase session list when lock details are denied", async () => {
    mocks.oceanbaseLockFailure = "ORA-01031: locks denied";
    await mountOceanbasePanel();
    processRow("21").querySelector<HTMLButtonElement>('button[title="processList.oracleLockDetails"]')?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("ORA-01031: locks denied"));
    expect(root?.textContent).toContain("OTHER");
    expect(root?.textContent).not.toContain("processList.oracleLockDetailsEmpty");
  });

  it("shows an empty OceanBase result only when the query completed without an error", async () => {
    mocks.oceanbaseRows = [];
    app = createApp(ProcessListPanel, { connection: oceanbaseConnection });
    app.mount(root!);
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.empty"));
    expect(root?.textContent).not.toContain("ORA-01031");
  });

  it("preserves an OceanBase termination permission denial instead of reporting success", async () => {
    mocks.oceanbaseTerminateFailure = "ORA-01031: KILL CONNECTION denied";
    await mountOceanbasePanel();
    processRow("21").querySelector<HTMLButtonElement>('button[title="processList.terminate"]')?.click();
    await nextTick();
    findDialogButton("processList.terminate")?.click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("ORA-01031: KILL CONNECTION denied"), 5000));
    expect(mocks.toast).not.toHaveBeenCalledWith("processList.terminateSuccess:21", 2500);
  });

  it("does not report an OceanBase session with changed tenant/node identity as terminated", async () => {
    await mountOceanbasePanel();
    processRow("21").querySelector<HTMLButtonElement>('button[title="processList.terminate"]')?.click();
    await nextTick();
    mocks.oceanbaseTargetChanged = true;
    findDialogButton("processList.terminate")?.click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("ORA-20001: Session identity changed"), 5000));
    const sql = mocks.executeQuery.mock.calls.map((call) => String(call[2])).find((statement) => statement.includes("EXECUTE IMMEDIATE 'KILL CONNECTION"));
    expect(sql).toContain(`ID = 21 AND "USER" = 'OTHER' AND TENANT = 'tenant_a'`);
    expect(sql).toContain("SVR_IP = '127.0.0.1' AND SVR_PORT = 2882");
    expect(mocks.oceanbaseTerminated).toBe(false);
    expect(mocks.toast).not.toHaveBeenCalledWith("processList.terminateSuccess:21", 2500);
  });

  it("terminates one Oracle row through the independent managed session and reads the row back", async () => {
    app = createApp(ProcessListPanel, { connection: oracleConnection });
    app.mount(root!);
    await vi.waitFor(() => expect(root?.textContent).toContain("21"));
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleSerial"));

    expect(gridButtons().some((button) => button.textContent?.trim() === "processList.kill")).toBe(false);
    const terminateButtons = gridButtons().filter((button) => button.textContent?.trim() === "processList.terminate");
    expect(terminateButtons).toHaveLength(2);
    expect(terminateButtons[0]?.disabled).toBe(true);
    expect(terminateButtons[1]?.disabled).toBe(false);

    terminateButtons[1]?.click();
    await nextTick();
    expect(root?.textContent).toContain("processList.oracleContainer");
    expect(root?.textContent).toContain("processList.oracleInstance");
    expect(root?.textContent).toContain("processList.oracleSerial");
    findDialogButton("processList.terminate")?.click();

    await vi.waitFor(() => expect(oracleTerminated).toBe(true));
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("processList.terminateSuccess:21", 2500));
    const actionCall = mocks.executeQuery.mock.calls.find((call) => String(call[2]).includes("ALTER SYSTEM KILL SESSION"));
    expect(actionCall?.[2]).toContain("CON_ID = 3");
    expect(actionCall?.[2]).toContain("SERIAL# = 42");
    const actionSession = (actionCall?.[5] as { clientSessionId?: string } | undefined)?.clientSessionId;
    expect(actionSession).toBeTruthy();
    expect(actionSession).toMatch(/^process-list:/);
    expect(mocks.executeQuery.mock.calls.every((call) => (call[5] as { clientSessionId?: string } | undefined)?.clientSessionId === actionSession)).toBe(true);
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("GV$SESSION")).every((call) => (call[5] as { clientSessionId?: string })?.clientSessionId === actionSession)).toBe(true);
    expect(mocks.contextGuard.mock.calls[0]?.[0]).toMatchObject({ scope: "connection", database: "", source: "production.sourceAdmin" });
    app?.unmount();
    app = null;
    expect(mocks.closeClientConnectionSession).toHaveBeenCalledWith(oracleConnection.id, "", actionSession);
  });

  it("preserves the database denial when termination outcome is unknown", async () => {
    oracleTerminateError = "ORA-01031: insufficient privileges";
    app = createApp(ProcessListPanel, { connection: oracleConnection });
    app.mount(root!);
    await vi.waitFor(() => expect(root?.textContent).toContain("21"));
    gridButtons()
      .filter((button) => button.textContent?.trim() === "processList.terminate")[1]
      ?.click();
    await nextTick();
    findDialogButton("processList.terminate")?.click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("ORA-01031: insufficient privileges"), 5000));
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("processList.oracleTerminateUnknown"), 5000);
  });

  it("opens lock details for the selected Oracle session using the managed session", async () => {
    app = createApp(ProcessListPanel, { connection: oracleConnection });
    app.mount(root!);
    await vi.waitFor(() => expect(root?.textContent).toContain("21"));

    const lockButtons = gridButtons().filter((button) => button.textContent?.trim() === "processList.oracleLockDetails");
    expect(lockButtons).toHaveLength(2);
    lockButtons[1]?.click();

    await vi.waitFor(() => expect(root?.textContent).toContain("TX"));
    expect(root?.textContent).toContain("processList.oracleLockTarget");
    const lockQuery = mocks.executeQuery.mock.calls.find((call) => String(call[2]).includes("FROM GV$LOCK l JOIN GV$SESSION s"));
    expect(lockQuery?.[2]).toContain("l.CON_ID = 3");
    const managedSession = (lockQuery?.[5] as { clientSessionId?: string } | undefined)?.clientSessionId;
    expect(managedSession).toBeTruthy();
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("GV$SESSION")).every((call) => (call[5] as { clientSessionId?: string })?.clientSessionId === managedSession)).toBe(true);
  });

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
