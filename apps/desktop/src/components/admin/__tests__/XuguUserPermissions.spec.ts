// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(),
  executeQuery: vi.fn(),
  executeMulti: vi.fn(),
  listDatabases: vi.fn(),
  toast: vi.fn(),
  guard: vi.fn(async ({ execute }: { execute: () => Promise<unknown> }) => execute()),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@lucide/vue", async () => {
  const { defineComponent, h } = await import("vue");
  const icon = defineComponent({ setup: () => () => h("i") });
  return { AlertTriangle: icon, KeyRound: icon, Loader2: icon, Plus: icon, RefreshCw: icon, ShieldCheck: icon, Trash2: icon, Unlock: icon, UserRound: icon, UsersRound: icon };
});
vi.mock("@/components/ui/badge", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Badge: defineComponent({
      inheritAttrs: false,
      setup:
        (_, { attrs, slots }) =>
        () =>
          h("span", attrs, slots.default?.()),
    }),
  };
});
vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      inheritAttrs: false,
      setup:
        (_, { attrs, slots }) =>
        () =>
          h("button", attrs, slots.default?.()),
    }),
  };
});
vi.mock("@/components/ui/input", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Input: defineComponent({
      inheritAttrs: false,
      props: { modelValue: { type: [String, Number], default: "" } },
      emits: ["update:modelValue"],
      setup(props, { attrs, emit }) {
        return () => h("input", { ...attrs, value: props.modelValue, onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value) });
      },
    }),
  };
});
vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = (tag: string) =>
    defineComponent({
      inheritAttrs: false,
      setup:
        (_, { attrs, slots }) =>
        () =>
          h(tag, attrs, slots.default?.()),
    });
  return {
    Dialog: defineComponent({
      props: { open: Boolean },
      setup:
        (props, { slots }) =>
        () =>
          props.open ? h("div", { "data-dialog": "" }, slots.default?.()) : null,
    }),
    DialogContent: passthrough("section"),
    DialogFooter: passthrough("footer"),
    DialogHeader: passthrough("header"),
    DialogTitle: passthrough("h2"),
  };
});
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ ensureConnected: mocks.ensureConnected }) }));
vi.mock("@/lib/backend/api", () => ({ executeQuery: mocks.executeQuery, executeMulti: mocks.executeMulti, listDatabases: mocks.listDatabases }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({
  executeWithProductionSqlGuard: mocks.guard,
}));

import XuguUserPermissions from "@/components/admin/XuguUserPermissions.vue";

let app: App<Element> | undefined;
let root: HTMLDivElement | undefined;

function queryResult(columns: string[], rows: unknown[][] = []) {
  return { columns, rows, affected_rows: 0, execution_time_ms: 0 };
}

function configureCompleteCatalogs() {
  mocks.executeQuery.mockImplementation(async (_connectionId: string, database: string, sql: string) => {
    if (database !== "SYSTEM") throw new Error(`Unexpected database context: ${database}`);
    if (sql.includes("SELECT DATABASE()")) return queryResult(["DATABASE_NAME"], [["SYSTEM"]]);
    if (sql.includes("FROM DBA_USERS")) return queryResult(["USER_ID", "USER_NAME", "LOCKED", "EXPIRED", "IS_SYS", "UNTIL_TIME", "ALIAS"], [[101, "APP_READER", false, false, false, null, null]]);
    if (sql.includes("FROM DBA_ROLES")) return queryResult(["USER_ID", "USER_NAME", "IS_SYS"], [[201, "APP_READ_ROLE", false]]);
    if (sql.includes("FROM DBA_SCHEMAS")) return queryResult(["SCHEMA_ID", "SCHEMA_NAME"], [[1, "APP_SCHEMA"]]);
    if (sql.includes("FROM DBA_ROLE_MEMBERS")) return queryResult(["USER_ID", "ROLE_ID"], []);
    if (sql.includes("FROM DBA_ACLS")) return queryResult(["GRANTOR_ID", "GRANTEE_ID", "OBJECT_ID", "OBJECT_TYPE", "AUTHORITY", "REGRANT", "SCOPE", "TARGET_NAME"], []);
    throw new Error(`Unexpected catalog request: ${sql}`);
  });
}

async function mountPage(readOnly = false) {
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(XuguUserPermissions, {
    connection: { id: "xugu-connection", name: "Xugu test", db_type: "xugu", database: "SYSTEM", read_only: readOnly } as never,
  });
  app.mount(root);
  await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalled());
  await vi.waitFor(() => expect(root?.textContent).toContain("APP_READER"));
  await nextTick();
  return root;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim().includes(text));
  if (!found) throw new Error(`Could not find button: ${text}`);
  return found as HTMLButtonElement;
}

beforeEach(() => {
  mocks.ensureConnected.mockReset().mockResolvedValue(undefined);
  mocks.executeQuery.mockReset();
  mocks.executeMulti.mockReset().mockResolvedValue([queryResult([])]);
  mocks.listDatabases.mockReset().mockResolvedValue([{ name: "SYSTEM" }, { name: "APP_DB" }]);
  mocks.toast.mockReset();
  mocks.guard.mockClear();
  root = undefined;
  app = undefined;
});

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  root = undefined;
  document.body.innerHTML = "";
});

describe("XuguUserPermissions", () => {
  it("keeps catalog reads in the confirmed database and shows SQL for review without executing it", async () => {
    configureCompleteCatalogs();
    const container = await mountPage();

    expect(mocks.ensureConnected).toHaveBeenCalledWith("xugu-connection");
    expect(mocks.executeQuery.mock.calls.every(([, database]) => database === "SYSTEM")).toBe(true);
    expect(container.textContent).toContain("xuguUserPermissions.scopeSystem");

    const privilegeCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(privilegeCheckbox).not.toBeNull();
    privilegeCheckbox!.click();
    await nextTick();
    buttonByText(container, "xuguUserPermissions.grant").click();
    await nextTick();

    expect(container.querySelector("[data-dialog]")?.textContent).toContain("GRANT");
    expect(mocks.executeMulti).not.toHaveBeenCalled();

    buttonByText(container, "xuguUserPermissions.execute").click();
    await vi.waitFor(() => expect(mocks.executeMulti).toHaveBeenCalledTimes(1));
    expect(mocks.guard).toHaveBeenCalledWith(expect.objectContaining({ database: "SYSTEM", connection: expect.objectContaining({ db_type: "xugu" }) }));
    expect(mocks.executeMulti.mock.calls[0]?.[2]).toContain("GRANT");
  });

  it("does not expose management actions on read-only connections", async () => {
    configureCompleteCatalogs();
    const container = await mountPage(true);

    expect(buttonByText(container, "xuguUserPermissions.newPrincipal").disabled).toBe(true);
    expect(buttonByText(container, "xuguUserPermissions.grant").disabled).toBe(true);
    expect(buttonByText(container, "xuguUserPermissions.revoke").disabled).toBe(true);
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it("keeps account creation confirmation database-local even after selecting an instance-wide grant scope", async () => {
    configureCompleteCatalogs();
    const container = await mountPage();
    await vi.waitFor(() => expect(buttonByText(container, "xuguUserPermissions.newPrincipal").disabled).toBe(false));

    const systemScope = Array.from(container.querySelectorAll("select")).find((select) => Array.from(select.options).some((option) => option.value === "system"));
    expect(systemScope).toBeDefined();
    systemScope!.value = "system";
    systemScope!.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();

    buttonByText(container, "xuguUserPermissions.newPrincipal").click();
    await nextTick();
    buttonByText(container, "xuguUserPermissions.createRole").click();
    await nextTick();
    const nameInput = Array.from(container.querySelectorAll("label"))
      .find((label) => label.textContent?.includes("xuguUserPermissions.name"))
      ?.querySelector("input");
    expect(nameInput).toBeDefined();
    nameInput!.value = "APP_TEST_ROLE";
    nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    buttonByText(container, "xuguUserPermissions.preview").click();
    await nextTick();
    const dialogText = container.querySelector("[data-dialog]")?.textContent ?? "";
    expect(dialogText).toContain("xuguUserPermissions.currentDatabaseOnly");
    expect(dialogText).not.toContain("xuguUserPermissions.systemWide");
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it("previews user creation with default roles and account lifecycle settings before execution", async () => {
    configureCompleteCatalogs();
    const container = await mountPage();
    buttonByText(container, "xuguUserPermissions.newPrincipal").click();
    await nextTick();

    const inputForLabel = (key: string) => {
      const label = Array.from(container.querySelectorAll("label")).find((candidate) => candidate.textContent?.includes(key));
      const input = label?.querySelector("input");
      if (!input) throw new Error(`Could not find input for ${key}`);
      return input;
    };
    const setInput = (key: string, value: string) => {
      const input = inputForLabel(key);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    setInput("xuguUserPermissions.name", "APP_NEW_USER");
    setInput("xuguUserPermissions.initialPassword", "Secret_123!");
    setInput("xuguUserPermissions.validUntil", "2035-06-07T08:09");

    const rolesLabel = Array.from(container.querySelectorAll("label")).find((candidate) => candidate.textContent?.includes("xuguUserPermissions.defaultRoles"));
    const roleSelect = rolesLabel?.querySelector("select");
    expect(roleSelect?.multiple).toBe(true);
    const roleOption = Array.from(roleSelect?.options ?? []).find((option) => option.value === "APP_READ_ROLE");
    expect(roleOption).toBeDefined();
    roleOption!.selected = true;
    roleSelect!.dispatchEvent(new Event("change", { bubbles: true }));

    for (const key of ["xuguUserPermissions.createLocked", "xuguUserPermissions.createPasswordExpired"]) {
      const input = inputForLabel(key);
      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await nextTick();
    buttonByText(container, "xuguUserPermissions.preview").click();
    await nextTick();

    const preview = container.querySelector("pre")?.textContent ?? "";
    expect(preview).toContain('DEFAULT ROLE "APP_READ_ROLE"');
    expect(preview).toContain("VALID UNTIL '2035-06-07 08:09'");
    expect(preview).toContain("ACCOUNT LOCK");
    expect(preview).toContain("PASSWORD EXPIRE");
    expect(preview).not.toContain("Secret_123!");
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it("previews account expiration changes and exposes table-level trigger privileges", async () => {
    configureCompleteCatalogs();
    const container = await mountPage();
    const objectScope = Array.from(container.querySelectorAll("select")).find((select) => Array.from(select.options).some((option) => option.value === "object"));
    objectScope!.value = "object";
    objectScope!.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    const objectType = Array.from(container.querySelectorAll("select")).find((select) => Array.from(select.options).some((option) => option.value === "TABLE"));
    expect(objectType).toBeDefined();
    expect(Array.from(objectType!.options).some((option) => option.value === "TRIGGER")).toBe(false);
    expect(Array.from(container.querySelectorAll("label")).some((label) => label.textContent?.trim() === "TRIGGER")).toBe(true);

    buttonByText(container, "xuguUserPermissions.accountSettings").click();
    await nextTick();
    const validUntilLabel = Array.from(container.querySelectorAll("label")).find((candidate) => candidate.textContent?.includes("xuguUserPermissions.setValidUntil"));
    const validUntil = validUntilLabel?.querySelector("input");
    expect(validUntil).toBeDefined();
    validUntil!.value = "2035-06-07T08:09";
    validUntil!.dispatchEvent(new Event("input", { bubbles: true }));
    const expiredLabel = Array.from(container.querySelectorAll("label")).find((candidate) => candidate.textContent?.includes("xuguUserPermissions.markPasswordExpired"));
    const expired = expiredLabel?.querySelector("input");
    expect(expired).toBeDefined();
    expired!.checked = true;
    expired!.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    buttonByText(container, "xuguUserPermissions.preview").click();
    await nextTick();

    const preview = container.querySelector("pre")?.textContent ?? "";
    expect(preview).toContain("VALID UNTIL '2035-06-07 08:09'");
    expect(preview).toContain("PASSWORD EXPIRE");
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it("fails closed when only limited visibility catalogs can be read", async () => {
    mocks.executeQuery.mockImplementation(async (_connectionId: string, database: string, sql: string) => {
      if (database !== "SYSTEM") throw new Error(`Unexpected database context: ${database}`);
      if (sql.includes("SELECT DATABASE()")) return queryResult(["DATABASE_NAME"], [["SYSTEM"]]);
      if (sql.includes("FROM DBA_USERS") || sql.includes("FROM DBA_ROLES") || sql.includes("FROM DBA_ROLE_MEMBERS") || sql.includes("FROM DBA_ACLS")) {
        return { ...queryResult([], []), execution_error: true, rows: [["insufficient privilege"]] };
      }
      if (sql.includes("FROM ALL_USERS")) return queryResult(["USER_ID", "USER_NAME", "LOCKED", "EXPIRED", "IS_SYS", "UNTIL_TIME", "ALIAS"], [[101, "APP_READER", false, false, false, null, null]]);
      if (sql.includes("FROM ALL_ROLE_MEMBERS")) return queryResult(["USER_ID", "ROLE_ID"], []);
      if (sql.includes("FROM ALL_SCHEMAS")) return queryResult(["SCHEMA_ID", "SCHEMA_NAME"], []);
      if (sql.includes("FROM ALL_ACLS")) return queryResult(["GRANTOR_ID", "GRANTEE_ID", "OBJECT_ID", "OBJECT_TYPE", "AUTHORITY", "REGRANT", "SCOPE", "TARGET_NAME"], []);
      throw new Error(`Unexpected catalog request: ${sql}`);
    });
    const container = await mountPage();

    expect(container.textContent).toContain("xuguUserPermissions.limitedCatalog");
    expect(buttonByText(container, "xuguUserPermissions.newPrincipal").disabled).toBe(true);
    expect(buttonByText(container, "xuguUserPermissions.grant").disabled).toBe(true);
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });
});
