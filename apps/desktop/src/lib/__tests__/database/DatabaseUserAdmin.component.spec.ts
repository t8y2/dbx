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
      return () => (attrs.open ? h("div", attrs, slots.default?.()) : null);
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
    Globe2: Icon,
    KeyRound: Icon,
    Lock: Icon,
    Loader2: Icon,
    Plus: Icon,
    RefreshCcw: Icon,
    Search: Icon,
    ShieldCheck: Icon,
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
vi.mock("@/components/ui/PasswordInput.vue", () => ({ default: passthrough("input") }));
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
  listDatabases: vi.fn(),
  listSchemas: vi.fn(),
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
  it("syncs privilege buttons and grant option from loaded SHOW GRANTS rows", async () => {
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["user", "host", "plugin"], rows: [["root", "%", "mysql_native_password"]] }).mockResolvedValueOnce({ columns: ["Grants for root@%"], rows: [["GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION"]] });

    root = document.createElement("div");
    document.body.append(root);
    app = createApp(DatabaseUserAdmin, { connection });
    app.mount(root);

    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(2));
    await nextTick();

    const privilegeButton = Array.from(root.querySelectorAll("button")).find((button) => button.textContent?.trim() === "INSERT");
    const grantOptionLabel = Array.from(root.querySelectorAll("label")).find((label) => label.textContent?.includes("userAdmin.grantOption"));
    const grantOptionInput = grantOptionLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]');

    expect(privilegeButton?.className).toContain("border-primary");
    expect(grantOptionInput?.checked).toBe(true);
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
    expect(mocks.executeQuery.mock.calls.slice(2).map((call) => call[2])).toEqual([
      "SELECT User AS user, Host AS host, plugin AS plugin FROM mysql.user ORDER BY User, Host;",
      "SHOW GRANTS FOR 'same-user'@'new-host';",
    ]);
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
