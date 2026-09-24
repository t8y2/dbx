// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type Component } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(),
  executeQuery: vi.fn(),
  executeMulti: vi.fn(),
  productionGuard: vi.fn(),
  toast: vi.fn(),
  listDatabases: vi.fn(),
  listTables: vi.fn(),
  listSchemas: vi.fn(),
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
      return () => (attrs.open ? h("div", { ...attrs, "data-test-dialog": "true" }, slots.default?.()) : null);
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

vi.mock("vue-i18n", () => ({
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
  useConnectionStore: () => ({ ensureConnected: mocks.ensureConnected }),
}));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("@/lib/backend/api", () => ({
  executeQuery: mocks.executeQuery,
  executeMulti: mocks.executeMulti,
  listDatabases: mocks.listDatabases,
  listTables: mocks.listTables,
  listSchemas: mocks.listSchemas,
}));
vi.mock("@/lib/database/productionExecutionGuard", () => ({
  executeWithProductionSqlGuard: (options: { execute: () => Promise<unknown> }) => {
    mocks.productionGuard(options);
    return options.execute();
  },
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

const nativeMysqlConnection: ConnectionConfig = {
  ...connection,
  id: "native-mysql",
  name: "Native MySQL",
  db_type: "mysql",
  driver_profile: "mysql",
  port: 3306,
};

let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement | undefined;

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  root = undefined;
  vi.clearAllMocks();
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
