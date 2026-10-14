// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type Component } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(),
  retirePasswordAfterChange: vi.fn(),
  connect: vi.fn(),
  getConfig: vi.fn(),
  guardCancelled: false,
  guardWait: undefined as Promise<void> | undefined,
  trackUiState: vi.fn(),
  executeQuery: vi.fn(),
  executeMulti: vi.fn(),
  connectDb: vi.fn(),
  disconnectDb: vi.fn(),
  saveConnections: vi.fn(),
  sessionCredentialStatus: vi.fn(),
  forgetSessionCredential: vi.fn(),
  loadSchemaCache: vi.fn(),
  checkConnectionHealth: vi.fn(),
  connectionIdentifierQuote: vi.fn(),
  productionGuard: vi.fn(),
  toast: vi.fn(),
  listDatabases: vi.fn(),
  listDorisCatalogs: vi.fn(),
  listDorisCatalogDatabases: vi.fn(),
  listTables: vi.fn(),
  listSchemas: vi.fn(),
  tabUiState: {} as Record<string, unknown>,
}));

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
      return () =>
        attrs.open
          ? h("div", { ...attrs, "data-test-dialog": "true" }, [
              ...(slots.default?.() ?? []),
              h("button", {
                type: "button",
                "data-test-request-close": "true",
                onClick: () => (attrs["onUpdate:open"] as ((open: boolean) => void) | undefined)?.(false),
              }),
            ])
          : null;
    },
  });
}

function passwordInput(): Component {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs }) {
      return () =>
        h("input", {
          ...attrs,
          "data-password-input": "true",
          value: attrs.modelValue as string,
          onInput: (event: Event) => (attrs["onUpdate:modelValue"] as ((value: string) => void) | undefined)?.((event.target as HTMLInputElement).value),
        });
    },
  });
}

vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values?.message ? `${key}: ${values.message}` : key),
  }),
}));
vi.mock("@lucide/vue", () => {
  const Icon = passthrough("span");
  return {
    AlertTriangle: Icon,
    Check: Icon,
    ChevronDown: Icon,
    Globe2: Icon,
    KeyRound: Icon,
    Lock: Icon,
    Loader2: Icon,
    Plus: Icon,
    RefreshCcw: Icon,
    Search: Icon,
    ShieldCheck: Icon,
    Table2: Icon,
    Trash2: Icon,
    Unlock: Icon,
    UserRound: Icon,
  };
});
vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("@/components/ui/badge", () => ({ Badge: passthrough("span") }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: modelDialog(),
  DialogContent: passthrough("div"),
  DialogFooter: passthrough("div"),
  DialogHeader: passthrough("div"),
  DialogTitle: passthrough("div"),
}));
vi.mock("@/components/ui/input", () => ({ Input: modelInput() }));
vi.mock("@/components/ui/PasswordInput.vue", () => ({ default: passwordInput() }));
vi.mock("@/components/ui/popover", () => ({
  Popover: passthrough("div"),
  PopoverContent: passthrough("div"),
  PopoverTrigger: passthrough("div"),
}));
vi.mock("@/components/ui/select", () => ({
  Select: passthrough("div"),
  SelectContent: passthrough("div"),
  SelectItem: passthrough("div"),
  SelectTrigger: passthrough("div"),
  SelectValue: passthrough("span"),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ ensureConnected: mocks.ensureConnected, retirePasswordAfterChange: mocks.retirePasswordAfterChange, connect: mocks.connect, getConfig: mocks.getConfig }),
}));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("@/lib/backend/api", () => ({
  connectDb: mocks.connectDb,
  disconnectDb: mocks.disconnectDb,
  saveConnections: mocks.saveConnections,
  sessionCredentialStatus: mocks.sessionCredentialStatus,
  forgetSessionCredential: mocks.forgetSessionCredential,
  loadSchemaCache: mocks.loadSchemaCache,
  checkConnectionHealth: mocks.checkConnectionHealth,
  connectionIdentifierQuote: mocks.connectionIdentifierQuote,
  executeQuery: mocks.executeQuery,
  executeMulti: mocks.executeMulti,
  listDatabases: mocks.listDatabases,
  listDorisCatalogs: mocks.listDorisCatalogs,
  listDorisCatalogDatabases: mocks.listDorisCatalogDatabases,
  listTables: mocks.listTables,
  listSchemas: mocks.listSchemas,
}));
vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({ rollbackConnectionTransactions: vi.fn(), closeConnectionTabs: vi.fn(), releaseConnectionTabs: vi.fn(), invalidateConnectionMetadata: vi.fn(), tabs: [], flushPendingPersist: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("@/lib/database/productionExecutionGuard", () => ({
  executeWithProductionSqlGuard: async (options: { execute: () => Promise<unknown> }) => {
    mocks.productionGuard(options);
    await mocks.guardWait;
    if (mocks.guardCancelled) return Promise.resolve(undefined);
    return options.execute();
  },
}));
vi.mock("@/lib/tabs/tabUiState", () => ({
  useTabUiState: () => ({ initialState: mocks.tabUiState, track: mocks.trackUiState, update: vi.fn() }),
}));

import DatabaseUserAdmin from "@/components/admin/DatabaseUserAdmin.vue";

const connection: ConnectionConfig = {
  id: "oceanbase",
  name: "OceanBase",
  db_type: "jdbc",
  driver_profile: "mysql",
  host: "localhost",
  port: 2881,
  username: "root",
  password: "",
};

const oracleConnection: ConnectionConfig = {
  ...connection,
  id: "same-oracle-connection",
  db_type: "oracle",
  driver_profile: "oracle",
  host: "old-host",
  port: 1521,
  database: "OLD_SERVICE",
};

const nativeMysqlConnection: ConnectionConfig = {
  ...connection,
  id: "native-mysql",
  name: "Native MySQL",
  db_type: "mysql",
  driver_profile: "mysql",
  port: 3306,
};

const postgresConnection: ConnectionConfig = {
  ...connection,
  id: "postgres",
  name: "PostgreSQL",
  db_type: "postgres",
  driver_profile: "postgres",
  database: "app-db",
  port: 5432,
};

const starrocksConnection: ConnectionConfig = {
  ...connection,
  id: "starrocks",
  name: "StarRocks",
  db_type: "starrocks",
  driver_profile: "starrocks",
  database: "analytics",
  port: 9030,
};

let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement | undefined;
let updateConnection: ((connection: ConnectionConfig) => void) | undefined;

function mountWithReactiveConnection(initialConnection: ConnectionConfig) {
  const Harness = defineComponent({
    setup(_, { expose }) {
      const current = ref(initialConnection);
      expose({ update: (connection: ConnectionConfig) => (current.value = connection) });
      return () => h(DatabaseUserAdmin, { connection: current.value });
    },
  });
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(Harness);
  app.mount(root);
  updateConnection = (app._instance?.exposed as { update: (connection: ConnectionConfig) => void }).update;
}

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  root = undefined;
  updateConnection = undefined;
  mocks.tabUiState = {};
  mocks.guardCancelled = false;
  mocks.guardWait = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("DatabaseUserAdmin connection identity", () => {
  it("does not execute a password preview after the same connection id is edited", async () => {
    const config = { ...postgresConnection, id: "same-user-admin-connection", db_type: "vastbase", username: "fixture_self", password: "saved-old" } as ConnectionConfig;
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.getConfig.mockReturnValue({ ...config, password: "", save_password: false });
    mocks.executeQuery.mockImplementation(async (_id, _database, sql: string) => (!sql.startsWith("WITH target") ? { columns: ["user", "host", "plugin"], rows: [["fixture_self", "LOGIN", ""]] } : { columns: ["grant"], rows: [] }));
    mountWithReactiveConnection(config);
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(2));
    findButton("userAdmin.changePassword")!.click();
    await nextTick();
    for (const [key, value] of [
      ["newPassword", "fixture-new"],
      ["oldPassword", "fixture-old"],
    ]) {
      const input = root!.querySelector<HTMLInputElement>(`input[placeholder="userAdmin.${key}"]`)!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await nextTick();
    findButton("userAdmin.previewSql")!.click();
    await nextTick();

    updateConnection!({ ...config, host: "new-host" });
    await nextTick();
    expect(findButton("userAdmin.applySql")).toBeUndefined();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it("does not retire a newly edited connection after a late self-password acknowledgement", async () => {
    const config = { ...postgresConnection, id: "same-user-admin-connection", db_type: "vastbase", username: "fixture_self", password: "saved-old" } as ConnectionConfig;
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.retirePasswordAfterChange.mockResolvedValue({ status: "skipped" });
    mocks.getConfig.mockReturnValue({ ...config, password: "", save_password: false });
    mocks.executeQuery.mockImplementation(async (_id, _database, sql: string) => (!sql.startsWith("WITH target") ? { columns: ["user", "host", "plugin"], rows: [["fixture_self", "LOGIN", ""]] } : { columns: ["grant"], rows: [] }));
    mountWithReactiveConnection(config);
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(2));
    findButton("userAdmin.changePassword")!.click();
    await nextTick();
    for (const [key, value] of [
      ["newPassword", "fixture-new"],
      ["oldPassword", "fixture-old"],
    ]) {
      const input = root!.querySelector<HTMLInputElement>(`input[placeholder="userAdmin.${key}"]`)!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await nextTick();
    findButton("userAdmin.previewSql")!.click();
    await nextTick();
    let finish!: (results: unknown[]) => void;
    mocks.executeMulti.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    findButton("userAdmin.applySql")!.click();
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(1));

    updateConnection!({ ...config, host: "new-host" });
    await nextTick();
    finish([{ columns: [], rows: [] }]);
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(1));

    expect(mocks.retirePasswordAfterChange).not.toHaveBeenCalled();
  });

  it.each(["success", "unknown", "refused"] as const)("retains a late %s acknowledgement after cancel and stops the next Oracle grant", async (acknowledgement) => {
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.listSchemas.mockResolvedValue(["OWNER_A", "OWNER_B"]);
    mocks.executeQuery.mockImplementation(async (_id, _database, sql: string) => {
      if (sql.includes("SELECT USER AS USERNAME")) return { columns: ["USERNAME"], rows: [["DBA"]] };
      if (sql.includes("DBA_USERS"))
        return {
          columns: ["USERNAME", "ACCOUNT_STATUS"],
          rows: [
            ["TARGET_USER", "OPEN"],
            ["OTHER_USER", "OPEN"],
          ],
        };
      if (sql.includes("DBA_ROLES")) return { columns: ["ROLE"], rows: [] };
      if (sql.includes("DBA_ROLE_PRIVS")) return { columns: ["GRANTEE", "GRANTED_ROLE", "ADMIN_OPTION", "DEFAULT_ROLE"], rows: [] };
      if (sql.includes("DBA_SYS_PRIVS")) return { columns: ["GRANTEE", "PRIVILEGE", "ADMIN_OPTION"], rows: [] };
      if (sql.includes("DBA_TAB_PRIVS")) return { columns: ["GRANTEE", "OWNER", "TABLE_NAME", "GRANTOR", "PRIVILEGE", "GRANTABLE"], rows: [] };
      if (sql.includes("DBA_COL_PRIVS")) return { columns: ["GRANTEE", "OWNER", "TABLE_NAME", "COLUMN_NAME", "GRANTOR", "PRIVILEGE", "GRANTABLE"], rows: [] };
      if (sql.includes("FROM ALL_OBJECTS")) {
        const owner = sql.match(/OWNER = '([^']+)'/)?.[1];
        return { columns: ["OBJECT_NAME", "OBJECT_TYPE"], rows: [[`TABLE_${owner}`, "TABLE"]] };
      }
      return { columns: [], rows: [] };
    });
    mountWithReactiveConnection(oracleConnection);
    await vi.waitFor(() => expect(root!.textContent).toContain("TARGET_USER"));
    Array.from(root!.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("TARGET_USER"))!
      .click();
    await nextTick();

    for (const owner of ["OWNER_A", "OWNER_B"]) {
      findButton(owner)!.click();
      await nextTick();
      const chooseObjects = Array.from(root!.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("oracleSecurity.chooseObjects"));
      expect(chooseObjects).toBeDefined();
      chooseObjects!.click();
      await vi.waitFor(() => expect(root!.textContent).toContain(`TABLE_${owner}`));
      Array.from(root!.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.includes(`TABLE_${owner}`))!
        .click();
      await nextTick();
    }
    findButton("userAdmin.grant")!.click();
    await nextTick();
    expect(findButton("userAdmin.applySql")).toBeDefined();

    let finishFirst!: (results: unknown[]) => void;
    let failFirst!: (error: Error) => void;
    mocks.executeMulti.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finishFirst = resolve;
          failFirst = reject;
        }),
    );
    findButton("userAdmin.applySql")!.click();
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(1));
    const cancel = Array.from(root!.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === "oracleSecurity.stopFollowing");
    expect(cancel).toBeDefined();
    cancel!.click();
    await nextTick();
    expect(root!.textContent).toContain("oracleSecurity.stoppingAwaitingResult");
    Array.from(root!.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("OTHER_USER"))!
      .click();
    await nextTick();

    if (acknowledgement === "success") finishFirst([{ columns: [], rows: [] }]);
    else if (acknowledgement === "refused") finishFirst([{ columns: [], rows: [["ORA-01031: insufficient privileges"]], execution_error: true }]);
    else failFirst(new Error("connection lost after dispatch"));
    const expectedReceipt = acknowledgement === "success" ? "userAdmin.resultPartial" : acknowledgement === "refused" ? "oracleSecurity.writeRejected" : "oracleSecurity.writeUnknown";
    await vi.waitFor(() => expect(root!.textContent).toContain(expectedReceipt));

    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
    expect(root!.textContent).toContain(expectedReceipt);
    expect(root!.textContent).toContain("OWNER_A.TABLE_OWNER_A");
    expect(root!.textContent).toContain("OWNER_B.TABLE_OWNER_B");
    expect(root!.textContent).toContain("OceanBase · oracle · TARGET_USER");
    expect(root!.textContent).toContain("oracleSecurity.notSentAfterStop");
  });

  it("discards an Oracle security read and snapshot when the same connection id is edited", async () => {
    let currentUser = "OLD_ADMIN";
    let releaseOldRead!: (result: { columns: string[]; rows: unknown[][] }) => void;
    let firstCurrentUserRead = true;
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.listSchemas.mockResolvedValue([]);
    mocks.executeQuery.mockImplementation(async (_id, _database, sql: string) => {
      if (sql.includes("SELECT USER AS USERNAME")) {
        if (firstCurrentUserRead) {
          firstCurrentUserRead = false;
          return new Promise((resolve) => (releaseOldRead = resolve));
        }
        return { columns: ["USERNAME"], rows: [[currentUser]] };
      }
      if (sql.includes("DBA_USERS")) return { columns: ["USERNAME", "ACCOUNT_STATUS"], rows: [[currentUser, "OPEN"]] };
      if (sql.includes("DBA_ROLES")) return { columns: ["ROLE"], rows: [] };
      if (sql.includes("DBA_ROLE_PRIVS") || sql.includes("DBA_SYS_PRIVS") || sql.includes("DBA_TAB_PRIVS") || sql.includes("DBA_COL_PRIVS")) {
        const columns = sql.includes("ROLE_PRIVS")
          ? ["GRANTEE", "GRANTED_ROLE", "ADMIN_OPTION", "DEFAULT_ROLE"]
          : sql.includes("SYS_PRIVS")
            ? ["GRANTEE", "PRIVILEGE", "ADMIN_OPTION"]
            : sql.includes("COL_PRIVS")
              ? ["GRANTEE", "OWNER", "TABLE_NAME", "COLUMN_NAME", "GRANTOR", "PRIVILEGE", "GRANTABLE"]
              : ["GRANTEE", "OWNER", "TABLE_NAME", "GRANTOR", "PRIVILEGE", "GRANTABLE"];
        return { columns, rows: [] };
      }
      return { columns: [], rows: [] };
    });
    mountWithReactiveConnection(oracleConnection);
    await vi.waitFor(() => expect(releaseOldRead).toBeDefined());
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(7));
    currentUser = "NEW_ADMIN";
    updateConnection!({ ...oracleConnection, host: "new-host", database: "NEW_SERVICE" });
    await nextTick();
    expect(mocks.executeQuery).toHaveBeenCalledTimes(14);

    await vi.waitFor(() => expect(root!.textContent).toContain("NEW_ADMIN"));
    releaseOldRead({ columns: ["USERNAME"], rows: [["OLD_ADMIN"]] });
    await nextTick();
    await nextTick();
    expect(root!.textContent).not.toContain("OLD_ADMIN");
  });

  it("skips a confirmed Oracle plan when the selected subject changes before dispatch", async () => {
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.listSchemas.mockResolvedValue(["OWNER_A"]);
    mocks.executeQuery.mockImplementation(async (_id, _database, sql: string) => {
      if (sql.includes("SELECT USER AS USERNAME")) return { columns: ["USERNAME"], rows: [["DBA"]] };
      if (sql.includes("DBA_USERS"))
        return {
          columns: ["USERNAME", "ACCOUNT_STATUS"],
          rows: [
            ["TARGET_USER", "OPEN"],
            ["OTHER_USER", "OPEN"],
          ],
        };
      if (sql.includes("DBA_ROLES")) return { columns: ["ROLE"], rows: [] };
      if (sql.includes("DBA_ROLE_PRIVS") || sql.includes("DBA_SYS_PRIVS") || sql.includes("DBA_TAB_PRIVS") || sql.includes("DBA_COL_PRIVS")) return { columns: ["GRANTEE", "PRIVILEGE"], rows: [] };
      if (sql.includes("FROM ALL_OBJECTS")) return { columns: ["OBJECT_NAME", "OBJECT_TYPE"], rows: [["TABLE_OWNER_A", "TABLE"]] };
      return { columns: [], rows: [] };
    });
    mountWithReactiveConnection(oracleConnection);
    await vi.waitFor(() => expect(root!.textContent).toContain("OTHER_USER"));
    Array.from(root!.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("TARGET_USER"))!
      .click();
    await nextTick();
    findButton("OWNER_A")!.click();
    await nextTick();
    Array.from(root!.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("oracleSecurity.chooseObjects"))!
      .click();
    await vi.waitFor(() => expect(root!.textContent).toContain("TABLE_OWNER_A"));
    Array.from(root!.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("TABLE_OWNER_A"))!
      .click();
    await nextTick();
    findButton("userAdmin.grant")!.click();
    await nextTick();

    let confirm!: () => void;
    mocks.guardWait = new Promise<void>((resolve) => {
      confirm = resolve;
    });
    findButton("userAdmin.applySql")!.click();
    await nextTick();
    Array.from(root!.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("OTHER_USER"))!
      .click();
    await nextTick();
    confirm();

    await vi.waitFor(() => expect(root!.textContent).toContain("oracleSecurity.notSentAfterStop"));
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(root!.textContent).toContain("OceanBase · oracle · TARGET_USER");
    expect(root!.textContent).toContain("userAdmin.resultFailed");
  });

  it.each(["transport rejection", "malformed acknowledgement"] as const)("retains an unknown receipt for a single Oracle statement after %s", async (failure) => {
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.executeQuery.mockImplementation(async (_id, _database, sql: string) => {
      if (sql.includes("SELECT USER AS USERNAME")) return { columns: ["USERNAME"], rows: [["DBA"]] };
      if (sql.includes("DBA_USERS")) return { columns: ["USERNAME", "ACCOUNT_STATUS"], rows: [["TARGET_USER", "OPEN"]] };
      if (sql.includes("DBA_ROLES")) return { columns: ["ROLE"], rows: [] };
      if (sql.includes("DBA_ROLE_PRIVS") || sql.includes("DBA_SYS_PRIVS") || sql.includes("DBA_TAB_PRIVS") || sql.includes("DBA_COL_PRIVS")) return { columns: ["GRANTEE", "PRIVILEGE"], rows: [] };
      return { columns: [], rows: [] };
    });
    mountWithReactiveConnection(oracleConnection);
    await vi.waitFor(() => expect(root!.textContent).toContain("TARGET_USER"));
    Array.from(root!.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("TARGET_USER"))!
      .click();
    await nextTick();
    findButton("userAdmin.lock")!.click();
    await nextTick();
    expect(findButton("userAdmin.applySql")).toBeDefined();

    if (failure === "transport rejection") mocks.executeMulti.mockRejectedValueOnce(new Error("connection lost after dispatch"));
    else mocks.executeMulti.mockResolvedValueOnce([{}] as any);
    findButton("userAdmin.applySql")!.click();
    await vi.waitFor(() => expect(root!.textContent).toContain("oracleSecurity.writeUnknown"));

    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
    expect(findButton("userAdmin.applySql")).toBeUndefined();
    expect(findButton("userAdmin.closeResult")).toBeDefined();
    expect(root!.textContent).toContain("OceanBase · oracle · TARGET_USER");
  });

  it("keeps a single Oracle statement pending and records its late acknowledgement after a close request", async () => {
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.executeQuery.mockImplementation(async (_id, _database, sql: string) => {
      if (sql.includes("SELECT USER AS USERNAME")) return { columns: ["USERNAME"], rows: [["DBA"]] };
      if (sql.includes("DBA_USERS")) return { columns: ["USERNAME", "ACCOUNT_STATUS"], rows: [["TARGET_USER", "OPEN"]] };
      if (sql.includes("DBA_ROLES") || sql.includes("DBA_ROLE_PRIVS") || sql.includes("DBA_SYS_PRIVS") || sql.includes("DBA_TAB_PRIVS") || sql.includes("DBA_COL_PRIVS")) return { columns: ["GRANTEE", "PRIVILEGE"], rows: [] };
      return { columns: [], rows: [] };
    });
    mountWithReactiveConnection(oracleConnection);
    await vi.waitFor(() => expect(root!.textContent).toContain("TARGET_USER"));
    Array.from(root!.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("TARGET_USER"))!
      .click();
    await nextTick();
    findButton("userAdmin.lock")!.click();
    await nextTick();
    expect(findButton("userAdmin.applySql")).toBeDefined();

    let acknowledge!: (results: unknown[]) => void;
    mocks.executeMulti.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    findButton("userAdmin.applySql")!.click();
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(1));

    const waiting = Array.from(root!.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === "common.pending");
    expect(waiting).toBeDefined();
    expect(waiting!.disabled).toBe(true);
    root!.querySelector<HTMLButtonElement>('[data-test-request-close="true"]')!.click();
    await nextTick();
    expect(root!.querySelector('[data-test-dialog="true"]')).not.toBeNull();

    acknowledge([{ columns: [], rows: [] }]);
    await vi.waitFor(() => expect(root!.textContent).toContain("userAdmin.resultSuccess"));
    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
    expect(root!.textContent).toContain("OceanBase · oracle · TARGET_USER");
    findButton("userAdmin.closeResult")!.click();
    await nextTick();
    expect(root!.querySelector('[data-test-dialog="true"]')).toBeNull();
  });
});

describe("DatabaseUserAdmin Vastbase passwords", () => {
  const config = { ...postgresConnection, id: "vastbase", db_type: "vastbase", username: "fixture_self", password: "saved-old" } as ConnectionConfig;

  async function mountPassword(user = "fixture_self", dbConfig = config) {
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.retirePasswordAfterChange.mockImplementation(async () => {
      const retired = { ...dbConfig, password: "", save_password: false };
      updateConnection?.(retired);
      return { status: "retired", fingerprint: connectionConfigFingerprint(retired) };
    });
    mocks.connect.mockResolvedValue(undefined);
    mocks.getConfig.mockReturnValue({ ...dbConfig, password: "", save_password: false });
    mocks.executeQuery.mockImplementation(async (_id, _db, sql: string) => (!sql.startsWith("WITH target") ? { columns: ["user", "host", "plugin"], rows: [[user, "LOGIN", ""]] } : { columns: ["grant"], rows: [] }));
    mountWithReactiveConnection(dbConfig);
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(2));
    findButton("userAdmin.changePassword")!.click();
    await nextTick();
  }

  async function preview(old = "fixture-old") {
    for (const [key, value] of [
      ["newPassword", "fixture-new"],
      ["oldPassword", old],
    ]) {
      const input = root!.querySelector<HTMLInputElement>(`input[placeholder="userAdmin.${key}"]`);
      expect(input).not.toBeNull();
      input!.value = value;
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await nextTick();
    findButton("userAdmin.previewSql")!.click();
    await nextTick();
  }

  it("retires self credentials immediately after mutation without refreshing", async () => {
    await mountPassword();
    await preview();
    expect(root!.textContent).toContain(`ALTER ROLE "fixture_self" IDENTIFIED BY 'fixture-new' REPLACE 'fixture-old';`);
    mocks.executeMulti.mockResolvedValueOnce([]);
    findButton("userAdmin.applySql")!.click();
    await vi.waitFor(() => expect(mocks.retirePasswordAfterChange).toHaveBeenCalledWith("vastbase", expect.any(String)));
    await nextTick();
    expect(mocks.executeMulti.mock.invocationCallOrder[0]).toBeLessThan(mocks.retirePasswordAfterChange.mock.invocationCallOrder[0]);
    expect(mocks.executeQuery).toHaveBeenCalledTimes(2);
    expect(mocks.ensureConnected).toHaveBeenCalledTimes(1);
    expect(root!.textContent).not.toContain("fixture-new");
    expect(root!.textContent).not.toContain("fixture-old");
    expect(mocks.toast).toHaveBeenCalledWith("userAdmin.passwordChangedReconnect", 8000);
    expect(mocks.connect).not.toHaveBeenCalled();
    const trackedState = mocks.trackUiState.mock.calls[0][0]();
    expect(JSON.stringify(trackedState)).not.toContain("fixture-new");
    expect(JSON.stringify(trackedState)).not.toContain("fixture-old");
  });

  it("keeps the reconnect notice when the real store retires the changed password", async () => {
    const { createPinia, setActivePinia } = await import("pinia");
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    setActivePinia(createPinia());
    const { useConnectionStore: useActualConnectionStore } = await vi.importActual<typeof import("@/stores/connectionStore")>("@/stores/connectionStore");
    const store = useActualConnectionStore();
    const storeConfig = { ...config, save_password: true };
    store.connections = [{ ...storeConfig }];
    store.connectedIds.add(storeConfig.id);
    mocks.disconnectDb.mockResolvedValue(undefined);
    mocks.saveConnections.mockResolvedValue(undefined);
    mocks.sessionCredentialStatus.mockResolvedValue(true);
    mocks.forgetSessionCredential.mockResolvedValue(undefined);
    mocks.loadSchemaCache.mockResolvedValue(null);
    mocks.checkConnectionHealth.mockResolvedValue(true);
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.executeQuery.mockImplementation(async (_id, _db, sql: string) => (!sql.startsWith("WITH target") ? { columns: ["user", "host", "plugin"], rows: [["fixture_self", "LOGIN", ""]] } : { columns: ["grant"], rows: [] }));
    mocks.retirePasswordAfterChange.mockImplementation((id, fingerprint) => store.retirePasswordAfterChange(id, fingerprint));
    const Harness = defineComponent({ setup: () => () => h(DatabaseUserAdmin, { connection: store.getConfig(storeConfig.id)! }) });
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(Harness);
    app.mount(root);
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(2));
    findButton("userAdmin.changePassword")!.click();
    await nextTick();
    for (const [key, value] of [
      ["newPassword", "fixture-new"],
      ["oldPassword", "fixture-old"],
    ]) {
      const input = root!.querySelector<HTMLInputElement>(`input[placeholder="userAdmin.${key}"]`)!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await nextTick();
    findButton("userAdmin.previewSql")!.click();
    await nextTick();
    mocks.executeMulti.mockResolvedValueOnce([]);
    findButton("userAdmin.applySql")!.click();

    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("userAdmin.passwordChangedReconnect", 8000));

    expect(store.getConfig(storeConfig.id)).toMatchObject({ password: "", save_password: false });
    expect(root!.textContent).toContain("userAdmin.passwordChangedReconnect");
    expect(mocks.executeQuery).toHaveBeenCalledTimes(2);
    expect(mocks.forgetSessionCredential).toHaveBeenCalledWith(storeConfig.id);
  });

  it("does not show the reconnect notice when the connection is edited during real store retirement", async () => {
    const { createPinia, setActivePinia } = await import("pinia");
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    setActivePinia(createPinia());
    const { useConnectionStore: useActualConnectionStore } = await vi.importActual<typeof import("@/stores/connectionStore")>("@/stores/connectionStore");
    const store = useActualConnectionStore();
    const storeConfig = { ...config, save_password: true };
    store.connections = [{ ...storeConfig }];
    store.connectedIds.add(storeConfig.id);
    mocks.disconnectDb.mockResolvedValue(undefined);
    mocks.saveConnections.mockResolvedValue(undefined);
    mocks.forgetSessionCredential.mockResolvedValue(undefined);
    mocks.loadSchemaCache.mockResolvedValue(null);
    mocks.checkConnectionHealth.mockResolvedValue(true);
    let finishStatus!: (value: boolean) => void;
    mocks.sessionCredentialStatus.mockImplementationOnce(() => new Promise((resolve) => (finishStatus = resolve)));
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.executeQuery.mockImplementation(async (_id, _db, sql: string) => (!sql.startsWith("WITH target") ? { columns: ["user", "host", "plugin"], rows: [["fixture_self", "LOGIN", ""]] } : { columns: ["grant"], rows: [] }));
    mocks.retirePasswordAfterChange.mockImplementation((id, fingerprint) => store.retirePasswordAfterChange(id, fingerprint));
    const Harness = defineComponent({ setup: () => () => h(DatabaseUserAdmin, { connection: store.getConfig(storeConfig.id)! }) });
    root = document.createElement("div");
    document.body.append(root);
    app = createApp(Harness);
    app.mount(root);
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(2));
    findButton("userAdmin.changePassword")!.click();
    await nextTick();
    for (const [key, value] of [
      ["newPassword", "fixture-new"],
      ["oldPassword", "fixture-old"],
    ]) {
      const input = root!.querySelector<HTMLInputElement>(`input[placeholder="userAdmin.${key}"]`)!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await nextTick();
    findButton("userAdmin.previewSql")!.click();
    await nextTick();
    mocks.executeMulti.mockResolvedValueOnce([]);
    findButton("userAdmin.applySql")!.click();
    await vi.waitFor(() => expect(finishStatus).toBeDefined());

    store.connections = [{ ...store.getConfig(storeConfig.id)!, host: "edited-host" }];
    await nextTick();
    finishStatus(true);

    await vi.waitFor(() => expect(mocks.retirePasswordAfterChange).toHaveBeenCalled());
    expect(store.getConfig(storeConfig.id)).toMatchObject({ host: "edited-host", password: "", save_password: false });
    expect(mocks.toast).not.toHaveBeenCalledWith("userAdmin.passwordChangedReconnect", 8000);
    expect(root!.textContent).not.toContain("userAdmin.passwordChangedReconnect");
  });

  it("refreshes after an authorized other-user reset without retiring current credentials", async () => {
    await mountPassword("fixture_other");
    await preview("");
    expect(root!.textContent).toContain(`ALTER ROLE "fixture_other" IDENTIFIED BY 'fixture-new';`);
    mocks.executeMulti.mockResolvedValueOnce([]);
    findButton("userAdmin.applySql")!.click();
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(4));
    expect(mocks.retirePasswordAfterChange).not.toHaveBeenCalled();
    expect(config.password).toBe("saved-old");
  });

  it.each(["missing old password", "wrong old password", "cross-admin denied"])("preserves credentials when the server reports %s", async (message) => {
    await mountPassword(message === "cross-admin denied" ? "fixture_admin" : "fixture_self");
    await preview(message === "missing old password" ? "" : "fixture-incorrect");
    mocks.executeMulti.mockResolvedValueOnce([{ execution_error: true, rows: [[message]] }]);
    findButton("userAdmin.applySql")!.click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(`userAdmin.applyFailed: ${message}`, 5000));
    expect(mocks.retirePasswordAfterChange).not.toHaveBeenCalled();
    expect(mocks.executeQuery).toHaveBeenCalledTimes(2);
    expect(config.password).toBe("saved-old");
  });

  it("does not execute or retire passwords when the production guard is cancelled", async () => {
    await mountPassword();
    await preview();
    mocks.guardCancelled = true;
    findButton("userAdmin.applySql")!.click();
    await vi.waitFor(() => expect(mocks.productionGuard).toHaveBeenCalled());
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(mocks.retirePasswordAfterChange).not.toHaveBeenCalled();
  });

  it("clears password fields and SQL when a preview is closed and reopened", async () => {
    await mountPassword();
    await preview();
    const cancels = Array.from(root!.querySelectorAll<HTMLButtonElement>("button")).filter((button) => button.textContent === "dangerDialog.cancel");
    cancels.at(-1)!.click();
    await nextTick();
    expect(root!.textContent).not.toContain("fixture-new");
    expect(root!.textContent).not.toContain("fixture-old");
    findButton("userAdmin.changePassword")!.click();
    await nextTick();
    expect(root!.querySelector<HTMLInputElement>('input[placeholder="userAdmin.newPassword"]')!.value).toBe("");
    expect(root!.querySelector<HTMLInputElement>('input[placeholder="userAdmin.oldPassword"]')!.value).toBe("");
    expect(findButton("userAdmin.previewSql")!.disabled).toBe(true);
  });

  it("does not dispatch a preview closed while confirmation is pending", async () => {
    await mountPassword();
    await preview();
    let confirm!: () => void;
    mocks.guardWait = new Promise<void>((resolve) => {
      confirm = resolve;
    });
    findButton("userAdmin.applySql")!.click();
    await nextTick();
    const cancels = Array.from(root!.querySelectorAll<HTMLButtonElement>("button")).filter((button) => button.textContent === "dangerDialog.cancel");
    cancels.at(-1)!.click();
    await nextTick();
    confirm();
    await nextTick();
    await nextTick();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(mocks.retirePasswordAfterChange).not.toHaveBeenCalled();
  });

  it("does not dispatch a preview when same-id connection settings change during confirmation", async () => {
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.getConfig.mockReturnValue({ ...config, password: "", save_password: false });
    mocks.executeQuery.mockImplementation(async (_id, _db, sql: string) => (!sql.startsWith("WITH target") ? { columns: ["user", "host", "plugin"], rows: [["fixture_self", "LOGIN", ""]] } : { columns: ["grant"], rows: [] }));
    mountWithReactiveConnection(config);
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(2));
    findButton("userAdmin.changePassword")!.click();
    await nextTick();
    await preview();
    let confirm!: () => void;
    mocks.guardWait = new Promise<void>((resolve) => {
      confirm = resolve;
    });
    findButton("userAdmin.applySql")!.click();
    await nextTick();
    updateConnection!({ ...config, host: "changed-during-confirmation" });
    await nextTick();
    confirm();
    await nextTick();
    await nextTick();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it("retains the mutation identity when its dialog closes during execution", async () => {
    await mountPassword();
    await preview();
    let finish!: (result: unknown[]) => void;
    mocks.executeMulti.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    findButton("userAdmin.applySql")!.click();
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalled());
    const cancels = Array.from(root!.querySelectorAll<HTMLButtonElement>("button")).filter((button) => button.textContent === "dangerDialog.cancel");
    cancels.at(-1)!.click();
    await nextTick();
    finish([]);
    await vi.waitFor(() => expect(mocks.retirePasswordAfterChange).toHaveBeenCalledWith(config.id, expect.any(String)));
    expect(mocks.executeQuery).toHaveBeenCalledTimes(2);
  });

  it("reports cleanup failure as an already changed password without retrying or refreshing", async () => {
    await mountPassword();
    await preview();
    mocks.executeMulti.mockResolvedValueOnce([]);
    mocks.retirePasswordAfterChange.mockImplementationOnce(async () => {
      updateConnection!({ ...config, password: "", save_password: false });
      throw new Error("cleanup failed");
    });
    findButton("userAdmin.applySql")!.click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("userAdmin.passwordChangedCleanupFailed", 10000));
    expect(mocks.executeQuery).toHaveBeenCalledTimes(2);
    expect(root!.textContent).not.toContain("fixture-new");
    expect(findButton("userAdmin.applySql")).toBeUndefined();
    expect(findButton("contextMenu.openConnection")).toBeUndefined();
  });

  it("loads users only after an explicit reconnect and starts the next operation with empty secrets", async () => {
    await mountPassword();
    await preview();
    mocks.executeMulti.mockResolvedValueOnce([]);
    findButton("userAdmin.applySql")!.click();
    await vi.waitFor(() => expect(mocks.retirePasswordAfterChange).toHaveBeenCalled());
    await nextTick();
    mocks.connect.mockRejectedValueOnce(new Error("prompt cancelled"));
    findButton("contextMenu.openConnection")!.click();
    await nextTick();
    await nextTick();
    expect(mocks.executeQuery).toHaveBeenCalledTimes(2);
    findButton("contextMenu.openConnection")!.click();
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(4));
    expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({ password: "", save_password: false }));
    findButton("userAdmin.changePassword")!.click();
    await nextTick();
    expect(root!.querySelector<HTMLInputElement>('input[placeholder="userAdmin.newPassword"]')!.value).toBe("");
    expect(root!.querySelector<HTMLInputElement>('input[placeholder="userAdmin.oldPassword"]')!.value).toBe("");
  });

  it("redacts passwords echoed by a rejected backend request", async () => {
    await mountPassword();
    await preview();
    mocks.executeMulti.mockRejectedValueOnce(new Error("rejected fixture-new with fixture-old"));
    findButton("userAdmin.applySql")!.click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("userAdmin.applyFailed: rejected *** with ***", 5000));
    expect(mocks.retirePasswordAfterChange).not.toHaveBeenCalled();
  });

  it("keeps the PostgreSQL password dialog and SQL unchanged", async () => {
    await mountPassword("fixture_self", { ...config, db_type: "postgres" });
    expect(root!.querySelector('input[placeholder="userAdmin.oldPassword"]')).toBeNull();
    const input = root!.querySelector<HTMLInputElement>('input[placeholder="userAdmin.newPassword"]')!;
    input.value = "fixture-new";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    findButton("userAdmin.previewSql")!.click();
    await nextTick();
    expect(root!.textContent).toContain(`ALTER ROLE "fixture_self" PASSWORD 'fixture-new';`);
    mocks.executeMulti.mockResolvedValueOnce([]);
    findButton("userAdmin.applySql")!.click();
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(4));
    expect(mocks.retirePasswordAfterChange).not.toHaveBeenCalled();
  });
});

describe("DatabaseUserAdmin MySQL grant loading", () => {
  it("syncs the grant option from loaded SHOW GRANTS rows and renders the database scope editor", async () => {
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["user", "host", "plugin"], rows: [["root", "%", "mysql_native_password"]] }).mockResolvedValueOnce({ columns: ["Grants for root@%"], rows: [["GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION"]] });

    root = document.createElement("div");
    document.body.append(root);
    app = createApp(DatabaseUserAdmin, { connection });
    app.mount(root);

    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(2));
    await nextTick();

    const grantOptionLabel = Array.from(root.querySelectorAll("label")).find((label) => label.textContent?.includes("userAdmin.grantOption"));
    const grantOptionInput = grantOptionLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]');

    expect(grantOptionInput?.checked).toBe(true);
    // MySQL 的权限编辑改为按数据库/表配置授权范围（与新增用户一致），固定的权限按钮由范围编辑器取代
    expect(root.querySelector('input[placeholder="userAdmin.searchDatabase"]')).not.toBeNull();
  });

  it("falls back to the current Doris user when SHOW ALL GRANTS requires GRANT_PRIV", async () => {
    const dorisConnection: ConnectionConfig = {
      ...connection,
      id: "doris-limited",
      name: "Doris limited",
      db_type: "doris",
      driver_profile: "doris",
      port: 9030,
      username: "dbx_limited",
    };
    const currentUserGrant = {
      columns: ["UserIdentity", "Comment", "Password", "Roles", "GlobalPrivs", "DatabasePrivs", "TablePrivs"],
      rows: [["'dbx_limited'@'%'", "", "Yes", null, null, "internal.analytics: Select_priv", null]],
    };
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.executeQuery.mockRejectedValueOnce(new Error("Access denied; you need the (GRANT) privilege"));
    mocks.executeQuery.mockResolvedValueOnce(currentUserGrant).mockResolvedValueOnce(currentUserGrant);

    root = document.createElement("div");
    document.body.append(root);
    app = createApp(DatabaseUserAdmin, { connection: dorisConnection });
    app.mount(root);

    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(3));
    await nextTick();

    expect(mocks.executeQuery.mock.calls.map((call) => call[2])).toEqual(["SHOW ALL GRANTS;", "SHOW GRANTS;", "SHOW GRANTS FOR 'dbx_limited'@'%';"]);
    expect(root.textContent).toContain("dbx_limited@%");
    expect(root.textContent).not.toContain("Access denied");
  });
});

function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(root?.querySelectorAll("button") ?? []).find((button) => button.textContent?.trim() === text);
}

// 权限编辑面板与新增用户弹窗复用同一个授权范围编辑器，断言弹窗内的控件时需要限定在弹窗范围内
function findDialogButton(text: string): HTMLButtonElement | undefined {
  const dialog = root?.querySelector('[data-test-dialog="true"]');
  return Array.from(dialog?.querySelectorAll("button") ?? []).find((button) => button.textContent?.trim() === text);
}

describe("DatabaseUserAdmin MySQL create-user table grants", () => {
  it("loads tables, requires a selection, and previews only the selected table grant", async () => {
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["user", "host", "plugin"], rows: [["root", "%", "caching_sha2_password"]] }).mockResolvedValueOnce({ columns: ["Grants"], rows: [["GRANT ALL PRIVILEGES ON *.* TO 'root'@'%'"]] });
    mocks.listDatabases.mockResolvedValue([{ name: "scope_test" }]);
    mocks.listTables.mockResolvedValue([
      { name: "allowed_table", table_type: "BASE TABLE" },
      { name: "blocked_table", table_type: "BASE TABLE" },
    ]);

    root = document.createElement("div");
    document.body.append(root);
    app = createApp(DatabaseUserAdmin, { connection: nativeMysqlConnection });
    app.mount(root);
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(2));

    findButton("userAdmin.newUser")?.click();
    await vi.waitFor(() => expect(mocks.listDatabases).toHaveBeenCalledWith("native-mysql"));
    await vi.waitFor(() => expect(findDialogButton("scope_test")).toBeDefined());
    findDialogButton("scope_test")?.click();
    const password = root.querySelector<HTMLInputElement>('[data-password-input="true"]');
    password!.value = "test-password";
    password!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    findDialogButton("userAdmin.specificTables")?.click();
    await vi.waitFor(() => expect(mocks.listTables).toHaveBeenCalledWith("native-mysql", "scope_test", ""));
    await nextTick();
    expect(findDialogButton("userAdmin.previewSql")?.disabled).toBe(true);

    findDialogButton("allowed_table")?.click();
    await nextTick();
    expect(findDialogButton("userAdmin.previewSql")?.disabled).toBe(false);
    findDialogButton("userAdmin.previewSql")?.click();

    await vi.waitFor(() => expect(root?.textContent).toContain("GRANT SELECT, SHOW VIEW ON `scope_test`.`allowed_table` TO 'app_user'@'%';"));
    expect(root.textContent).not.toContain("ON `scope_test`.*");
    expect(root.textContent).not.toContain("`blocked_table`");
  });
});

describe("DatabaseUserAdmin PostgreSQL create-user table grants", () => {
  it("loads schema-qualified tables and keeps same-named tables distinct", async () => {
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["user", "host", "plugin"], rows: [["postgres", "LOGIN", "SUPERUSER"]] }).mockResolvedValueOnce({ columns: ["line"], rows: [["Role: postgres"]] });
    mocks.listDatabases.mockResolvedValue([{ name: "app-db" }]);
    mocks.listSchemas.mockResolvedValue(["sales", "audit", "pg_catalog"]);
    mocks.listTables.mockImplementation(async (_connectionId, _database, schema) => [{ name: "orders", table_type: "BASE TABLE" }, ...(schema === "sales" ? [{ name: 'daily"rollup', table_type: "BASE TABLE" }] : [])]);

    root = document.createElement("div");
    document.body.append(root);
    app = createApp(DatabaseUserAdmin, { connection: postgresConnection });
    app.mount(root);
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(2));

    findButton("userAdmin.newUser")?.click();
    await vi.waitFor(() => expect(findDialogButton("app-db")).toBeDefined());
    findDialogButton("app-db")?.click();
    const password = root.querySelector<HTMLInputElement>('[data-password-input="true"]');
    password!.value = "test-password";
    password!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    findDialogButton("userAdmin.specificTables")?.click();

    await vi.waitFor(() => expect(mocks.listTables).toHaveBeenCalledTimes(2));
    expect(mocks.listTables.mock.calls.map((call) => call[2])).toEqual(["sales", "audit"]);
    expect(findDialogButton("sales.orders")).toBeDefined();
    expect(findDialogButton("audit.orders")).toBeDefined();
    findDialogButton("sales.orders")?.click();
    findDialogButton("audit.orders")?.click();
    findDialogButton('sales.daily"rollup')?.click();
    await nextTick();
    findDialogButton("userAdmin.previewSql")?.click();

    await vi.waitFor(() => expect(root?.textContent).toContain('GRANT SELECT ON TABLE "sales"."orders" TO "app_user";'));
    expect(root?.textContent).toContain('GRANT SELECT ON TABLE "audit"."orders" TO "app_user";');
    expect(root?.textContent).toContain('GRANT SELECT ON TABLE "sales"."daily""rollup" TO "app_user";');
    expect(root?.textContent).not.toContain("ON ALL TABLES");
  });

  it("loads an existing schema-qualified grant and executes its revoke in the target database", async () => {
    mocks.tabUiState = { privilegeScope: "table" };
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.executeQuery.mockImplementation(async (_connectionId, database, sql) => {
      if (sql.includes('r.rolname AS "user"')) return { columns: ["user", "host", "plugin"], rows: [["reader", "LOGIN", ""]] };
      if (sql.includes("FROM information_schema.table_privileges") && !sql.includes("UNION ALL")) return { columns: ["schema", "table", "privilege", "grant_option"], rows: [["sales", "orders", "SELECT", "NO"]] };
      return { columns: ["line"], rows: [["Role: reader"]] };
    });
    mocks.listDatabases.mockResolvedValue([{ name: "app-db" }]);
    mocks.listSchemas.mockResolvedValue(["sales"]);
    mocks.listTables.mockResolvedValue([{ name: "orders", table_type: "BASE TABLE" }]);

    root = document.createElement("div");
    document.body.append(root);
    app = createApp(DatabaseUserAdmin, { connection: postgresConnection });
    app.mount(root);

    await vi.waitFor(() => expect(findButton("userAdmin.revoke")?.disabled).toBe(false));
    expect(root.textContent).toContain("userAdmin.selectedTableCount");
    findButton("userAdmin.revoke")?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain('REVOKE SELECT ON TABLE "sales"."orders" FROM "reader";'));

    mocks.executeMulti.mockResolvedValue([]);
    findButton("userAdmin.applySql")?.click();
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalled());
    expect(mocks.executeMulti.mock.calls[0][1]).toBe("app-db");
    expect(mocks.executeMulti.mock.calls[0][2]).toBe('REVOKE SELECT ON TABLE "sales"."orders" FROM "reader";');
  });
});

describe("DatabaseUserAdmin StarRocks table grants", () => {
  it("loads catalog-qualified tables for create and previews catalog-aware SQL", async () => {
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["User"], rows: [["'root'@'%'"]] }).mockResolvedValueOnce({ columns: ["UserIdentity", "Catalog", "Grants"], rows: [["'root'@'%'", null, "GRANT 'root' TO USER 'root'@'%'"]] });
    mocks.listDorisCatalogs.mockResolvedValue([
      { name: "default_catalog", catalog_type: "Internal", is_current: true },
      { name: "hive`catalog", catalog_type: "Hive", is_current: false },
    ]);
    mocks.listDorisCatalogDatabases.mockResolvedValue([{ name: "analytics" }]);
    mocks.listTables.mockResolvedValue([{ name: "event`log", table_type: "BASE TABLE" }]);

    root = document.createElement("div");
    document.body.append(root);
    app = createApp(DatabaseUserAdmin, { connection: starrocksConnection });
    app.mount(root);
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(2));
    findButton("userAdmin.newUser")?.click();

    await vi.waitFor(() => expect(findDialogButton("hive`catalog / analytics")).toBeDefined());
    findDialogButton("hive`catalog / analytics")?.click();
    const password = root.querySelector<HTMLInputElement>('[data-password-input="true"]');
    password!.value = "test-password";
    password!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    findDialogButton("userAdmin.specificTables")?.click();
    await vi.waitFor(() => expect(mocks.listTables).toHaveBeenCalled());
    expect(mocks.listTables).toHaveBeenCalledWith("starrocks", "analytics", "", undefined, undefined, undefined, ["TABLE"], "hive`catalog");
    await vi.waitFor(() => expect(findDialogButton("event`log")).toBeDefined());
    findDialogButton("event`log")?.click();
    await nextTick();
    findDialogButton("userAdmin.previewSql")?.click();

    await vi.waitFor(() => expect(root?.textContent).toContain("SET CATALOG `hive``catalog`;"));
    expect(root?.textContent).toContain("GRANT SELECT ON TABLE `analytics`.`event``log` TO USER 'app_user'@'%';");

    mocks.executeMulti.mockResolvedValue([]);
    mocks.executeQuery.mockResolvedValue({ columns: ["User"], rows: [["'app_user'@'%'"]] });
    findButton("userAdmin.applySql")?.click();
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(2));
    expect(mocks.executeMulti.mock.calls[1][5]).toEqual(expect.objectContaining({ catalog: "hive`catalog" }));
  });

  it("restores a direct table grant and previews its revoke diff", async () => {
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["User"], rows: [["'reader'@'%'"]] }).mockResolvedValueOnce({
      columns: ["UserIdentity", "Catalog", "Grants"],
      rows: [["'reader'@'%'", "default", "GRANT SELECT ON TABLE `analytics`.`events` TO USER 'reader'@'%'"]],
    });
    mocks.listDorisCatalogs.mockResolvedValue([{ name: "default_catalog", catalog_type: "Internal", is_current: true }]);
    mocks.listDorisCatalogDatabases.mockResolvedValue([{ name: "analytics" }]);

    root = document.createElement("div");
    document.body.append(root);
    app = createApp(DatabaseUserAdmin, { connection: starrocksConnection });
    app.mount(root);

    await vi.waitFor(() => expect(findButton("userAdmin.revoke")?.disabled).toBe(false));
    expect(root.textContent).toContain("userAdmin.selectedTableCount");
    findButton("userAdmin.revoke")?.click();

    await vi.waitFor(() => expect(root?.textContent).toContain("REVOKE SELECT ON TABLE `analytics`.`events` FROM USER 'reader'@'%';"));
    expect(root?.textContent).toContain("SET CATALOG `default_catalog`;");
  });
});

describe("DatabaseUserAdmin MySQL privilege editing", () => {
  it("previews one grant per selected table for the selected user", async () => {
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["user", "host", "plugin"], rows: [["root", "%", "caching_sha2_password"]] }).mockResolvedValueOnce({ columns: ["Grants"], rows: [["GRANT SELECT ON *.* TO 'root'@'%'"]] });
    mocks.listDatabases.mockResolvedValue([{ name: "scope_test" }]);
    mocks.listTables.mockResolvedValue([
      { name: "allowed_table", table_type: "BASE TABLE" },
      { name: "blocked_table", table_type: "BASE TABLE" },
    ]);

    root = document.createElement("div");
    document.body.append(root);
    app = createApp(DatabaseUserAdmin, { connection: nativeMysqlConnection });
    app.mount(root);
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(findButton("scope_test")).toBeDefined());

    findButton("scope_test")?.click();
    await nextTick();
    findButton("userAdmin.specificTables")?.click();
    await vi.waitFor(() => expect(mocks.listTables).toHaveBeenCalledWith("native-mysql", "scope_test", ""));
    await nextTick();

    findButton("allowed_table")?.click();
    findButton("blocked_table")?.click();
    await nextTick();
    findButton("userAdmin.grant")?.click();

    await vi.waitFor(() => expect(root?.textContent).toContain("GRANT SELECT, SHOW VIEW ON `scope_test`.`allowed_table` TO 'root'@'%';"));
    expect(root?.textContent).toContain("GRANT SELECT, SHOW VIEW ON `scope_test`.`blocked_table` TO 'root'@'%';");
  });
});

describe("DatabaseUserAdmin MySQL global scope", () => {
  it("grants the global scope through the fixed entry and hides table scope", async () => {
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["user", "host", "plugin"], rows: [["root", "%", "caching_sha2_password"]] }).mockResolvedValueOnce({ columns: ["Grants"], rows: [["GRANT SELECT ON *.* TO 'root'@'%'"]] });
    mocks.listDatabases.mockResolvedValue([{ name: "scope_test" }]);

    root = document.createElement("div");
    document.body.append(root);
    app = createApp(DatabaseUserAdmin, { connection: nativeMysqlConnection });
    app.mount(root);
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(findButton("userAdmin.globalScope")).toBeDefined());

    findButton("userAdmin.globalScope")?.click();
    await nextTick();

    // 全局作用域没有表级粒度，不应出现表范围控件
    expect(findButton("userAdmin.specificTables")).toBeUndefined();

    findButton("userAdmin.grant")?.click();

    await vi.waitFor(() => expect(root?.textContent).toContain("GRANT SELECT, SHOW VIEW ON *.* TO 'root'@'%';"));
    expect(root?.textContent).not.toContain("ON `scope_test`.*");
  });
});

async function mountNativeMysqlUserAdmin() {
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.executeQuery.mockResolvedValueOnce({ columns: ["user", "host", "plugin"], rows: [["same-user", "old-host", "caching_sha2_password"]] }).mockResolvedValueOnce({ columns: ["Grants"], rows: [["GRANT SELECT ON *.* TO 'same-user'@'old-host'"]] });
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(DatabaseUserAdmin, { connection: nativeMysqlConnection });
  app.mount(root);
  await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(2));
  await nextTick();
}

describe("DatabaseUserAdmin MySQL account Host changes", () => {
  it("shows the action only for native MySQL and validates the replacement Host", async () => {
    await mountNativeMysqlUserAdmin();

    findButton("userAdmin.changeHost")?.click();
    await nextTick();
    const hostInput = root?.querySelector<HTMLInputElement>('input[placeholder="userAdmin.newHost"]');
    const previewButton = findButton("userAdmin.previewSql");

    expect(hostInput?.value).toBe("old-host");
    expect(previewButton?.disabled).toBe(true);
    hostInput!.value = "   ";
    hostInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(previewButton?.disabled).toBe(true);
    hostInput!.value = "  old-host  ";
    hostInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(previewButton?.disabled).toBe(true);

    const nonNativeRoot = document.createElement("div");
    document.body.append(nonNativeRoot);
    app?.unmount();
    mocks.executeQuery.mockReset();
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["user", "host", "plugin"], rows: [["same-user", "old-host", "mysql_native_password"]] }).mockResolvedValueOnce({ columns: ["Grants"], rows: [[]] });
    app = createApp(DatabaseUserAdmin, { connection });
    app.mount(nonNativeRoot);
    root?.remove();
    root = nonNativeRoot;
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(2));
    expect(findButton("userAdmin.changeHost")).toBeUndefined();
  });

  it("previews the exact RENAME USER SQL and reloads the renamed identity after success", async () => {
    await mountNativeMysqlUserAdmin();
    findButton("userAdmin.changeHost")?.click();
    await nextTick();
    const hostInput = root?.querySelector<HTMLInputElement>('input[placeholder="userAdmin.newHost"]');
    hostInput!.value = "new-host";
    hostInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    findButton("userAdmin.previewSql")?.click();
    await nextTick();

    expect(root?.textContent).toContain("RENAME USER 'same-user'@'old-host' TO 'same-user'@'new-host';");
    expect(findButton("userAdmin.applySql")?.getAttribute("variant")).toBe("destructive");

    mocks.executeMulti.mockResolvedValueOnce([]);
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["user", "host", "plugin"], rows: [["same-user", "new-host", "caching_sha2_password"]] }).mockResolvedValueOnce({ columns: ["Grants"], rows: [["GRANT SELECT ON *.* TO 'same-user'@'new-host'"]] });
    findButton("userAdmin.applySql")?.click();

    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mocks.executeQuery.mock.calls.some((call) => call[2] === "SHOW GRANTS FOR 'same-user'@'new-host';")).toBe(true));
    expect(mocks.executeMulti.mock.calls[0][2]).toBe("RENAME USER 'same-user'@'old-host' TO 'same-user'@'new-host';");
    expect(mocks.productionGuard).toHaveBeenCalledWith(expect.objectContaining({ connection: nativeMysqlConnection, sql: "RENAME USER 'same-user'@'old-host' TO 'same-user'@'new-host';" }));
    expect(mocks.executeQuery.mock.calls.slice(2).map((call) => call[2])).toEqual(["SELECT User AS user, Host AS host, plugin AS plugin FROM mysql.user ORDER BY User, Host;", "SHOW GRANTS FOR 'same-user'@'new-host';"]);
    expect(root?.textContent).toContain("same-user@new-host");
    expect(root?.querySelector('input[placeholder="userAdmin.newHost"]')).toBeNull();
  });

  it("keeps the old identity selected and surfaces execution errors", async () => {
    await mountNativeMysqlUserAdmin();
    findButton("userAdmin.changeHost")?.click();
    await nextTick();
    const hostInput = root?.querySelector<HTMLInputElement>('input[placeholder="userAdmin.newHost"]');
    hostInput!.value = "existing-host";
    hostInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    findButton("userAdmin.previewSql")?.click();
    await nextTick();
    mocks.executeMulti.mockResolvedValueOnce([{ columns: ["error"], rows: [["Operation RENAME USER failed"]], execution_error: true }]);
    findButton("userAdmin.applySql")?.click();

    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("userAdmin.applyFailed: Operation RENAME USER failed", 5000));
    expect(root?.textContent).toContain("same-user@old-host");
    expect(root?.querySelector<HTMLInputElement>('input[placeholder="userAdmin.newHost"]')?.value).toBe("existing-host");
    expect(mocks.executeQuery).toHaveBeenCalledTimes(2);
  });
});
