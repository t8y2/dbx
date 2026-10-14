// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";
import type { ConnectionConfig } from "@/types/database";
import en from "@/i18n/locales/en";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  executeQuery: vi.fn(),
  listSchemas: vi.fn().mockResolvedValue(["APP_OWNER"]),
  listDatabases: vi.fn().mockResolvedValue([]),
  executeMulti: vi.fn().mockResolvedValue([{ columns: [], rows: [], execution_error: false }]),
  retirePasswordAfterChange: vi.fn().mockResolvedValue(undefined),
  requestConfirmation: vi.fn().mockResolvedValue(true),
  toast: vi.fn(),
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) => (key.split(".").reduce((value: any, part) => value?.[part], en) ?? key).replace(/\{(\w+)\}/g, (_match: string, name: string) => String(values?.[name] ?? name)) }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/stores/productionSafetyStore", () => ({ useProductionSafetyStore: () => ({ requestConfirmation: mocks.requestConfirmation }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("@/lib/tabs/tabUiState", () => ({ useTabUiState: () => ({ initialState: {}, track: vi.fn() }) }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ ensureConnected: mocks.ensureConnected, retirePasswordAfterChange: mocks.retirePasswordAfterChange }) }));
vi.mock("@/lib/backend/api", () => ({ executeQuery: mocks.executeQuery, executeMulti: mocks.executeMulti, listSchemas: mocks.listSchemas, listDatabases: mocks.listDatabases }));
vi.mock("@/components/ui/button", () => ({
  Button: defineComponent({
    setup:
      (_, { attrs, slots }) =>
      () =>
        h("button", attrs, slots.default?.()),
  }),
}));
vi.mock("@/components/ui/input", () => ({
  Input: defineComponent({
    props: ["modelValue"],
    emits: ["update:modelValue"],
    setup:
      (props, { attrs, emit }) =>
      () =>
        h("input", { ...attrs, value: props.modelValue, onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value) }),
  }),
}));
import DatabaseUserAdmin from "@/components/admin/DatabaseUserAdmin.vue";

const cleanup: (() => void)[] = [];
const mountedPages = new WeakMap<HTMLElement, { refresh: () => Promise<void> }>();
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.clearAllMocks();
});
async function settle() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await nextTick();
  }
}
function mount(db_type: "oracle" | "oceanbase-oracle" = "oracle", extra: Partial<ConnectionConfig> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(DatabaseUserAdmin, { connection: { id: "oracle", name: "Oracle test", db_type, ...extra } as ConnectionConfig });
  app.mount(host);
  mountedPages.set(host, {
    refresh: async () => {
      (host.querySelector("button") as HTMLButtonElement).click();
      await settle();
    },
  });
  cleanup.push(() => {
    app.unmount();
    host.remove();
  });
  return host;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe("Oracle security page", () => {
  it("loads the production reader, exposes limited visibility and filters object grants", async () => {
    mocks.executeQuery.mockImplementation(async (_connection: string, _database: string, sql: string) => {
      if (sql.includes("DBA_USERS")) throw new Error("ORA-01031");
      if (sql.includes("ALL_USERS") || sql.includes("FROM DUAL")) return { columns: ["USERNAME"], rows: [["Reader"]] };
      if (sql.includes("DBA_TAB_PRIVS"))
        return {
          columns: ["GRANTEE", "OWNER", "TABLE_NAME", "GRANTOR", "PRIVILEGE", "GRANTABLE"],
          rows: [
            ["Reader", "Owner", "T", "Owner", "SELECT", "NO"],
            ["Reader", "Other", "T", "Other", "UPDATE", "NO"],
            ["Reader", "Owner", "T", null, "DELETE", "NO"],
          ],
        };
      return { columns: [], rows: [] };
    });
    const host = mount();
    await settle();
    expect(host.textContent).toContain("Limited visibility");
    expect(host.textContent).toContain("Account status unavailable");
    expect(host.textContent).toContain("Other.T");
    expect(host.textContent).toContain("grantor: Unknown");
    const search = host.querySelector("input") as HTMLInputElement;
    search.value = "No matching account";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(host.querySelector("main")?.textContent).toContain("Reader");
    expect(host.querySelector("select")).toBeNull();
    expect(host.textContent).toContain("One discovered inheritance path is shown per role");
    const owner = host.querySelector('input[placeholder="Exact object owner"]') as HTMLInputElement;
    owner.value = "Owner";
    owner.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(host.textContent).toContain("Owner.T");
    expect(host.textContent).not.toContain("Other.T");
    expect(mocks.executeQuery.mock.calls.every((call) => /^SELECT\s/.test(call[2]))).toBe(true);
    expect(mocks.executeQuery.mock.calls.every((call) => call[5]?.maxRows === 10000)).toBe(true);
  });

  it("does not label failed dictionary reads as empty grants", async () => {
    mocks.executeQuery.mockRejectedValue(new Error("connection lost"));
    const host = mount();
    await settle();
    expect(host.querySelectorAll('[data-security-state="error"]').length).toBe(7);
    expect(host.textContent).toContain("Read failed");
    expect(host.textContent).not.toContain("Empty in visible scope");
    expect(host.textContent).not.toContain("No grants in the current visible result");
  });

  it("does not start dictionary reads after the page closes while connecting", async () => {
    let connected!: () => void;
    mocks.ensureConnected.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        connected = resolve;
      }),
    );
    mount();
    cleanup.splice(0).forEach((dispose) => dispose());
    connected();
    await settle();
    expect(mocks.executeQuery).not.toHaveBeenCalled();
  });

  it("uses the OceanBase fallback dialect when opening a restricted connection", async () => {
    mocks.executeQuery.mockImplementation(async (_connection: string, _database: string, sql: string) => {
      if (/FROM DBA_/.test(sql)) throw new Error("ORA-00942");
      if (sql.includes("FROM USER_ROLE_PRIVS UNION") && !sql.startsWith("SELECT GRANTEE,")) throw new Error("ORA-00904");
      if (sql.includes("FROM ALL_COL_PRIVS") && !sql.startsWith("SELECT GRANTEE, OWNER,")) throw new Error("ORA-00904");
      return { columns: [], rows: [] };
    });
    const host = mount("oceanbase-oracle");
    await settle();
    expect(host.textContent).not.toContain("ORA-00904");
    expect(host.querySelectorAll('[data-security-state="error"]').length).toBe(0);
    expect(host.textContent).toContain("Limited visibility");
  });

  it("invalidates an old connection wait before issuing any queries", async () => {
    const old = deferred<void>();
    mocks.ensureConnected.mockImplementation((id: string) => (id === "old" ? old.promise : Promise.resolve()));
    mocks.executeQuery.mockResolvedValue({ columns: [], rows: [] });
    const connection = ref({ id: "old", db_type: "oracle" } as ConnectionConfig);
    const host = document.createElement("div");
    const app = createApp({ setup: () => () => h(DatabaseUserAdmin, { connection: connection.value }) });
    app.mount(host);
    cleanup.push(() => app.unmount());
    connection.value = { id: "new", db_type: "oceanbase-oracle" } as ConnectionConfig;
    await settle();
    old.resolve();
    await settle();
    expect(mocks.executeQuery.mock.calls).toHaveLength(7);
    expect(mocks.executeQuery.mock.calls.every(([id]) => id === "new")).toBe(true);
    mocks.ensureConnected.mockResolvedValue(undefined);
  });

  it("keeps the latest refresh and ignores old failures and fallback reads", async () => {
    const old = deferred<{ columns: string[]; rows: string[][] }>();
    mocks.executeQuery.mockReturnValue(old.promise);
    const host = mount();
    await settle();
    mocks.executeQuery.mockImplementation(async (_id: string, _db: string, sql: string) => ({ columns: ["USERNAME"], rows: sql.includes("FROM DUAL") || sql.includes("DBA_USERS") ? [["LATEST"]] : [] }));
    // Refresh while an earlier load is pending.
    await mountedPages.get(host)!.refresh();
    await settle();
    const calls = mocks.executeQuery.mock.calls.length;
    old.reject(new Error("ORA-01031"));
    await settle();
    expect(mocks.executeQuery).toHaveBeenCalledTimes(calls);
    expect(host.textContent).toContain("LATEST");
    expect(host.textContent).not.toContain("ORA-01031");
  });

  it("preserves partial grants while indicating failed role visibility", async () => {
    mocks.executeQuery.mockImplementation(async (_id: string, _db: string, sql: string) => {
      if (sql.includes("DBA_ROLE_PRIVS")) throw new Error("connection lost");
      if (sql.includes("FROM DUAL") || sql.includes("DBA_USERS")) return { columns: ["USERNAME"], rows: [["Reader"]] };
      if (sql.includes("DBA_TAB_PRIVS")) return { columns: ["GRANTEE", "OWNER", "TABLE_NAME", "PRIVILEGE"], rows: [["Reader", "Owner", "T", "SELECT"]] };
      return { columns: [], rows: [] };
    });
    const host = mount();
    await settle();
    expect(host.textContent).toContain("Owner.T");
    expect(host.textContent).toContain("Grant sources are incomplete");
    expect(host.textContent).not.toContain("No grants in the current visible result");
  });

  it("shows a confirmed empty visible result after successful reads", async () => {
    mocks.executeQuery.mockResolvedValue({ columns: [], rows: [] });
    const host = mount();
    await settle();
    expect(host.textContent).toContain("No grants in the current visible result");
  });

  it("uses the shared list, hides account actions for roles, and collapses technical detail", async () => {
    mocks.executeQuery.mockImplementation(async (_id: string, _db: string, sql: string) => {
      if (sql.includes("FROM DUAL")) return { columns: ["USERNAME"], rows: [["Reader"]] };
      if (sql.includes("DBA_USERS") || sql.includes("ALL_USERS")) throw new Error("ORA-01031");
      if (sql.includes("DBA_ROLES")) return { columns: ["ROLE"], rows: [["R1"]] };
      if (sql.includes("DBA_TAB_PRIVS")) return { columns: ["GRANTEE", "OWNER", "TABLE_NAME", "PRIVILEGE"], rows: [["R1", "Owner", "RoleTable", "SELECT"]] };
      return { columns: [], rows: [] };
    });
    const host = mount();
    await settle();
    expect(host.querySelector("aside")?.textContent).toContain("Reader");
    expect(host.querySelector("aside")?.textContent).toContain("PUBLIC");
    const role = [...host.querySelectorAll<HTMLButtonElement>("aside button")].find((button) => button.textContent?.includes("R1"))!;
    role.click();
    await settle();
    expect(host.querySelector("main")?.textContent).toContain("Owner.RoleTable");
    expect([...host.querySelectorAll("details")].every((details) => !details.open)).toBe(true);
    expect(host.querySelector('[role="status"]')?.closest("details")).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("incomplete");
    expect(host.querySelector("[data-oracle-security] > p")?.textContent).toContain(en.oracleSecurity.directSqlNotice);
    expect(host.querySelector("[data-direct-grants]")?.closest("details")).toBeNull();
    const buttons = [...host.querySelectorAll("button")].map((button) => button.textContent);
    for (const text of [en.userAdmin.newUser, en.userAdmin.changePassword, en.userAdmin.dropUser, en.userAdmin.lock, en.userAdmin.unlock]) expect(buttons).not.toContain(text);
    expect(buttons).toContain(en.userAdmin.grant);
    expect(mocks.executeQuery.mock.calls.every((call) => /^SELECT\s/.test(call[2]))).toBe(true);
    const details = [...host.querySelectorAll("details")].find((item) => item.querySelector("summary")?.textContent === "Read details")!;
    details.open = true;
    expect(details.textContent).toContain("ORA-01031");
  });

  it.each(["mysql", "postgres"] as const)("discards a late %s user-list failure after switching to Oracle", async (db_type) => {
    const old = deferred<{ columns: string[]; rows: string[][] }>();
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.executeQuery.mockImplementation((id: string, _db: string, sql: string) => (id === "old" ? old.promise : Promise.resolve({ columns: ["USERNAME"], rows: sql.includes("FROM DUAL") ? [["Reader"]] : [] })));
    const connection = ref({ id: "old", db_type } as ConnectionConfig);
    const host = document.createElement("div");
    const app = createApp({ setup: () => () => h(DatabaseUserAdmin, { connection: connection.value }) });
    app.mount(host);
    cleanup.push(() => app.unmount());
    await settle();
    connection.value = { id: "new", db_type: "oracle" } as ConnectionConfig;
    await settle();
    old.reject(new Error("old dictionary failure"));
    await settle();
    expect(host.querySelector("main")?.textContent).toContain("Reader");
    expect(host.textContent).not.toContain("old dictionary failure");
    expect(mocks.executeQuery.mock.calls.filter(([id]) => id === "old")).toHaveLength(1);
    expect(mocks.executeQuery.mock.calls.filter(([id]) => id === "new")).toHaveLength(7);
  });

  it("discards Oracle results and fallback reads after switching to MySQL", async () => {
    const old = deferred<{ columns: string[]; rows: string[][] }>();
    mocks.executeQuery.mockImplementation((id: string, _db: string, sql: string) => (id === "old" ? old.promise : Promise.resolve(sql.includes("mysql.user") ? { columns: ["user", "host"], rows: [["app", "%"]] } : { columns: ["grants"], rows: [["GRANT SELECT ON *.* TO 'app'@'%'"]] })));
    const connection = ref({ id: "old", db_type: "oracle" } as ConnectionConfig);
    const host = document.createElement("div");
    const app = createApp({ setup: () => () => h(DatabaseUserAdmin, { connection: connection.value }) });
    app.mount(host);
    cleanup.push(() => app.unmount());
    await settle();
    connection.value = { id: "new", db_type: "mysql" } as ConnectionConfig;
    await settle();
    old.reject(new Error("ORA-01031"));
    await settle();
    expect(host.querySelector("main")?.textContent).toContain("app@%");
    expect(host.querySelector("[data-oracle-security]")).toBeNull();
    expect(host.textContent).not.toContain("ORA-01031");
    expect(mocks.executeQuery.mock.calls.filter(([id]) => id === "old")).toHaveLength(7);
    expect(mocks.executeQuery.mock.calls.filter(([id]) => id === "new")).toHaveLength(2);
  });

  it("finishes a pending MySQL grant read when refresh returns the same principal", async () => {
    const pending = deferred<{ columns: string[]; rows: string[][] }>();
    mocks.executeQuery.mockImplementation((_id: string, _db: string, sql: string) => (sql.startsWith("SHOW GRANTS") ? pending.promise : Promise.resolve({ columns: ["user", "host"], rows: [["app", "%"]] })));
    const host = document.createElement("div");
    const app = createApp(DatabaseUserAdmin, { connection: { id: "mysql", db_type: "mysql" } as ConnectionConfig });
    app.mount(host);
    cleanup.push(() => app.unmount());
    await settle();
    (host.querySelector("button") as HTMLButtonElement).click();
    await settle();
    pending.resolve({ columns: ["grants"], rows: [["GRANT SELECT ON *.* TO 'app'@'%'"]] });
    await settle();
    expect(host.textContent).not.toContain(en.userAdmin.loadingGrants);
    expect(host.querySelector("main")?.textContent).toContain("GRANT SELECT");
  });

  it("closes a MySQL create dialog and discards late grants when switching to Oracle", async () => {
    const old = deferred<{ columns: string[]; rows: string[][] }>();
    mocks.executeQuery.mockImplementation((id: string, _db: string, sql: string) => {
      if (id === "old" && sql.startsWith("SHOW GRANTS")) return old.promise;
      if (id === "old") return Promise.resolve({ columns: ["user", "host"], rows: [["app", "%"]] });
      return Promise.resolve({ columns: ["USERNAME"], rows: sql.includes("FROM DUAL") ? [["Reader"]] : [] });
    });
    const connection = ref({ id: "old", db_type: "mysql" } as ConnectionConfig);
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({ setup: () => () => h(DatabaseUserAdmin, { connection: connection.value }) });
    app.mount(host);
    cleanup.push(() => {
      app.unmount();
      host.remove();
    });
    await settle();
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(en.userAdmin.newUser))!.click();
    await settle();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    connection.value = { id: "new", db_type: "oracle" } as ConnectionConfig;
    await settle();
    old.reject(new Error("late grants failed"));
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).not.toContain("late grants failed");
    expect(host.querySelector("main")?.textContent).toContain("Reader");
    expect(host.querySelector("[data-oracle-security]")).not.toBeNull();
  });
});

describe("Oracle management through the shared page", () => {
  function setup() {
    mocks.executeQuery.mockImplementation(async (_id: string, _db: string, sql: string) =>
      sql.includes("ALL_OBJECTS")
        ? {
            columns: ["OBJECT_NAME", "OBJECT_TYPE"],
            rows: [
              ["Mixed.Table", "TABLE"],
              ["Second", "TABLE"],
              ["Third", "TABLE"],
            ],
          }
        : { columns: ["USERNAME"], rows: sql.includes("FROM DUAL") || sql.includes("DBA_USERS") ? [["Reader"]] : [] },
    );
  }
  async function click(text: string) {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text);
    expect(button, text).toBeDefined();
    button!.click();
    await settle();
  }
  async function fill(placeholder: string, value: string) {
    const input = [...document.querySelectorAll<HTMLInputElement>("input")].find((input) => input.placeholder === placeholder)!;
    expect(input, placeholder).toBeDefined();
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
  }
  it("previews lock and unlock, then executes only after confirmation", async () => {
    setup();
    mount();
    await settle();
    expect(document.body.textContent).not.toContain(en.userAdmin.changeHost);
    expect(document.querySelector(`input[placeholder="${en.userAdmin.searchUser}"]`)).toBeNull();
    expect(document.querySelector(`input[placeholder="${en.oracleSecurity.filter}"]`)).not.toBeNull();
    await click(en.userAdmin.lock);
    expect(document.body.textContent).toContain('ALTER USER "Reader" ACCOUNT LOCK;');
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    await click(en.userAdmin.applySql);
    expect(mocks.executeMulti.mock.calls[0][2]).toBe('ALTER USER "Reader" ACCOUNT LOCK;');
    await click(en.userAdmin.unlock);
    await click(en.userAdmin.applySql);
    expect(mocks.executeMulti.mock.calls[1][2]).toBe('ALTER USER "Reader" ACCOUNT UNLOCK;');
  });
  it("keeps the SQL preview layout usable before and after execution", async () => {
    setup();
    mount();
    await settle();
    await click(en.userAdmin.lock);

    const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
    expect(dialog.classList.contains("max-h-[calc(var(--dbx-viewport-height)-2rem)]")).toBe(true);
    expect(dialog.classList.contains("grid-rows-[auto_minmax(0,1fr)_auto]")).toBe(true);
    const sql = dialog.querySelector("pre")!;
    const middle = sql.parentElement!;
    expect(middle.classList.contains("grid-rows-[minmax(0,1fr)]")).toBe(true);
    expect(middle.classList.contains("h-[50vh]")).toBe(true);
    expect(middle.classList.contains("max-h-full")).toBe(true);

    await click(en.userAdmin.applySql);
    expect(middle.classList.contains("h-[70vh]")).toBe(true);
    expect(middle.classList.contains("grid-rows-[minmax(0,1fr)_minmax(0,1fr)]")).toBe(true);
    const resultPane = middle.children[1] as HTMLElement;
    for (const pane of [sql, resultPane]) {
      expect(pane.classList.contains("min-h-0")).toBe(true);
      expect(pane.classList.contains("min-w-0")).toBe(true);
      expect(pane.classList.contains("overscroll-contain")).toBe(true);
    }
    expect(sql.classList.contains("overflow-auto")).toBe(true);
    expect(resultPane.classList.contains("overflow-y-auto")).toBe(true);
    expect(resultPane.textContent).toContain(en.userAdmin.resultSuccess);
    await click(en.userAdmin.closeResult);
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
  });
  it("supports the old password for inferred Oracle JDBC through preview and dispatch", async () => {
    setup();
    const connection = ref({ id: "oracle-jdbc", name: "Oracle JDBC", db_type: "jdbc", driver_profile: "oracle", username: "Reader", password: "saved-secret", save_password: true } as ConnectionConfig);
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({ setup: () => () => h(DatabaseUserAdmin, { connection: connection.value }) });
    app.mount(host);
    cleanup.push(() => {
      app.unmount();
      host.remove();
    });
    mocks.retirePasswordAfterChange.mockImplementation(async () => {
      const retired = { ...connection.value, password: "", save_password: false };
      connection.value = retired;
      return { status: "retired", fingerprint: connectionConfigFingerprint(retired) };
    });
    await settle();
    await click(en.userAdmin.changePassword);
    await fill(en.userAdmin.oldPassword, "old-secret");
    await fill(en.userAdmin.newPassword, "new-secret");
    await click(en.userAdmin.previewSql);
    expect(document.body.textContent).toContain('IDENTIFIED BY "***" REPLACE "***"');
    expect(document.body.textContent).not.toContain("old-secret");
    expect(document.body.textContent).not.toContain("new-secret");
    await click(en.userAdmin.applySql);
    expect(mocks.executeMulti.mock.calls[0][2]).toBe('ALTER USER "Reader" IDENTIFIED BY "new-secret" REPLACE "old-secret";');
    expect(mocks.retirePasswordAfterChange).toHaveBeenCalledWith("oracle-jdbc", expect.any(String));
    expect(document.body.textContent).toContain(en.userAdmin.passwordChangedReconnect);
  });
  it.each([
    { db_type: "oracle" as const, supported: true },
    { db_type: "oceanbase-oracle" as const, supported: false },
  ])("keeps native and OceanBase old-password behavior for $db_type", async ({ db_type, supported }) => {
    setup();
    mount(db_type);
    await settle();
    await click(en.userAdmin.changePassword);
    expect(document.querySelector(`input[placeholder="${en.userAdmin.oldPassword}"]`) !== null).toBe(supported);
  });
  it("masks a self-password preview and production confirmation, then retires the connection", async () => {
    setup();
    const connection = ref({ id: "oracle", name: "Oracle test", db_type: "oracle", is_production: true, username: "reader" } as ConnectionConfig);
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({ setup: () => () => h(DatabaseUserAdmin, { connection: connection.value }) });
    app.mount(host);
    cleanup.push(() => {
      app.unmount();
      host.remove();
    });
    mocks.retirePasswordAfterChange.mockImplementation(async () => {
      const retired = { ...connection.value, password: "", save_password: false };
      connection.value = retired;
      return { status: "retired", fingerprint: connectionConfigFingerprint(retired) };
    });
    await settle();
    await settle();
    await click(en.userAdmin.changePassword);
    await fill(en.userAdmin.newPassword, "test';--pass");
    await click(en.userAdmin.previewSql);
    expect(document.body.textContent).not.toContain("test';--pass");
    expect(document.body.textContent).toContain('IDENTIFIED BY "***"');
    await click(en.userAdmin.applySql);
    expect(mocks.requestConfirmation.mock.calls[0][0].sql).toContain('IDENTIFIED BY "***"');
    expect(mocks.executeMulti.mock.calls[0][2]).toBe('ALTER USER "Reader" IDENTIFIED BY "test\';--pass";');
    expect(mocks.retirePasswordAfterChange).toHaveBeenCalledWith("oracle", expect.any(String));
    expect(document.body.textContent).toContain(en.userAdmin.passwordChangedReconnect);
  });
  it("invalidates a pending production confirmation when the principal changes", async () => {
    setup();
    const confirmation = deferred<boolean>();
    mocks.requestConfirmation.mockReturnValueOnce(confirmation.promise);
    mount("oracle", { is_production: true });
    await settle();
    await click(en.userAdmin.lock);
    await click(en.userAdmin.applySql);
    await click(en.oracleSecurity.stopBeforeDispatch);
    await click("PUBLIC");
    confirmation.resolve(true);
    await settle();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });
  it("uses the read-only guard and never sends a management statement on a locked connection", async () => {
    setup();
    mount("oracle", { read_only: true });
    await settle();
    await click(en.userAdmin.lock);
    await click(en.userAdmin.applySql);
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });
  it("grants and revokes only the selected principal's specified object privileges", async () => {
    setup();
    mount();
    await settle();
    expect(document.querySelector('input[placeholder="APP_OWNER"]')).toBeNull();
    expect(document.body.textContent).not.toContain(en.userAdmin.globalScope);
    await click("APP_OWNER");
    expect(document.body.textContent).not.toContain(en.userAdmin.allTables);
    await click(`${en.oracleSecurity.chooseObjects} (0)`);
    await click("Mixed.Table · TABLE");
    await click(en.userAdmin.grant);
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    await click(en.userAdmin.applySql);
    expect(mocks.executeMulti.mock.calls[0][2]).toBe('GRANT SELECT ON "APP_OWNER"."Mixed.Table" TO "Reader";');
    expect(mocks.executeQuery.mock.calls.filter((call) => call[2].includes("FROM DUAL")).length).toBe(2);
    await click(en.common.close);
    await click(en.userAdmin.revoke);
    await click(en.userAdmin.applySql);
    expect(mocks.executeMulti.mock.calls[1][2]).toBe('REVOKE SELECT ON "APP_OWNER"."Mixed.Table" FROM "Reader";');
  });
  it.each([
    { results: [] },
    {
      results: [
        { columns: [], rows: [] },
        { columns: [], rows: [] },
      ],
    },
  ])("keeps invalid plan acknowledgements unknown and stops subsequent objects: %j", async ({ results }) => {
    setup();
    mount();
    await settle();
    await click("APP_OWNER");
    await click(`${en.oracleSecurity.chooseObjects} (0)`);
    await click("Mixed.Table · TABLE");
    await click("Second · TABLE");
    mocks.executeMulti.mockResolvedValueOnce(results);
    await click(en.userAdmin.grant);
    await click(en.userAdmin.applySql);
    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(en.oracleSecurity.writeUnknown);
  });
  it("preserves a successful first step and stops after a second object is rejected", async () => {
    setup();
    mount();
    await settle();
    await click("APP_OWNER");
    await click(`${en.oracleSecurity.chooseObjects} (0)`);
    for (const name of ["Mixed.Table", "Second", "Third"]) await click(`${name} · TABLE`);
    mocks.executeMulti.mockResolvedValueOnce([{ columns: [], rows: [] }]).mockResolvedValueOnce([{ execution_error: true, columns: ["error"], rows: [["ORA-01031 rejected"]] }]);
    await click(en.userAdmin.grant);
    await click(en.userAdmin.applySql);
    expect(mocks.executeMulti).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain(en.oracleSecurity.writeRejected);
    expect(mocks.toast.mock.calls.at(-1)?.[0]).toContain(en.userAdmin.applyPartial);
  });
  it("cancels an object plan while production confirmation is pending", async () => {
    setup();
    const confirmation = deferred<boolean>();
    mocks.requestConfirmation.mockReturnValueOnce(confirmation.promise);
    mount("oracle", { is_production: true });
    await settle();
    await click("APP_OWNER");
    await click(`${en.oracleSecurity.chooseObjects} (0)`);
    await click("Mixed.Table · TABLE");
    await click(en.userAdmin.grant);
    await click(en.userAdmin.applySql);
    await click(en.oracleSecurity.stopBeforeDispatch);
    await click("PUBLIC");
    confirmation.resolve(true);
    await settle();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });
  it("blocks truncated object lists without presenting them as an empty successful read", async () => {
    setup();
    const query = mocks.executeQuery.getMockImplementation()!;
    mocks.executeQuery.mockImplementation((id, db, sql) => (sql.includes("ALL_OBJECTS") ? Promise.resolve({ columns: ["OBJECT_NAME", "OBJECT_TYPE"], rows: [["T", "TABLE"]], truncated: true }) : query(id, db, sql)));
    mount();
    await settle();
    await click("APP_OWNER");
    await click(`${en.oracleSecurity.chooseObjects} (0)`);
    expect(document.body.textContent).toContain(en.oracleSecurity.truncated);
    expect([...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === en.userAdmin.grant)?.disabled).toBe(true);
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });
  it("lists both objects when a PACKAGE shares its name with a TABLE", async () => {
    setup();
    const query = mocks.executeQuery.getMockImplementation()!;
    mocks.executeQuery.mockImplementation((id, db, sql) =>
      sql.includes("ALL_OBJECTS")
        ? Promise.resolve({
            columns: ["OBJECT_NAME", "OBJECT_TYPE"],
            rows: [
              ["Shared", "PACKAGE"],
              ["Shared", "TABLE"],
            ],
          })
        : query(id, db, sql),
    );
    mount();
    await settle();
    await click("APP_OWNER");
    await click(`${en.oracleSecurity.chooseObjects} (0)`);
    expect(document.body.textContent).toContain("Shared · PACKAGE");
    expect(document.body.textContent).toContain("Shared · TABLE");
  });
  it.each(["connection reset", "statement timed out", "ORA-03113: end-of-file on communication channel"])("keeps a returned execution error outcome unknown: %s", async (message) => {
    setup();
    mocks.executeMulti.mockResolvedValueOnce([{ columns: ["error"], rows: [[message]], execution_error: true }]);
    mount();
    await settle();
    await click(en.userAdmin.changePassword);
    await fill(en.userAdmin.newPassword, "fixture-secret");
    await click(en.userAdmin.previewSql);
    await click(en.userAdmin.applySql);
    expect(document.body.textContent).toContain(en.oracleSecurity.writeUnknown);
    expect(document.body.textContent).not.toContain(en.userAdmin.applySql);
    expect(mocks.retirePasswordAfterChange).not.toHaveBeenCalled();
    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
  });
  it("does not treat a missing execution acknowledgement as a successful password change", async () => {
    setup();
    mocks.executeMulti.mockResolvedValueOnce([]);
    mount();
    await settle();
    await click(en.userAdmin.changePassword);
    await fill(en.userAdmin.newPassword, "fixture-secret");
    await click(en.userAdmin.previewSql);
    await click(en.userAdmin.applySql);
    expect(document.body.textContent).toContain(en.oracleSecurity.writeUnknown);
    expect(document.body.textContent).not.toContain(en.userAdmin.applySql);
    expect(mocks.retirePasswordAfterChange).not.toHaveBeenCalled();
  });
  it("distinguishes a rejected statement without displaying an echoed password", async () => {
    setup();
    mocks.executeMulti.mockResolvedValueOnce([{ columns: ["error"], rows: [['ORA-01031 near IDENTIFIED BY "test-partial']], execution_error: true }]);
    mount();
    await settle();
    await click(en.userAdmin.changePassword);
    await fill(en.userAdmin.newPassword, "test-partial-secret");
    await click(en.userAdmin.previewSql);
    await click(en.userAdmin.applySql);
    expect(document.body.textContent).toContain(en.oracleSecurity.writeRejected);
    expect(document.body.textContent).not.toContain("test-partial");
    expect(mocks.retirePasswordAfterChange).not.toHaveBeenCalled();
  });
});
