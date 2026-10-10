// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({ ensureConnected: vi.fn().mockResolvedValue(undefined), executeQuery: vi.fn() }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref("en") }) }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ ensureConnected: mocks.ensureConnected }) }));
vi.mock("@/lib/backend/api", () => ({ executeQuery: mocks.executeQuery }));
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
import OracleSecurityAdmin from "@/components/admin/OracleSecurityAdmin.vue";

const cleanup: (() => void)[] = [];
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
function mount(dbType: ConnectionConfig["db_type"] = "oracle") {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(OracleSecurityAdmin, { connection: { id: "oracle", db_type: dbType } as ConnectionConfig });
  app.mount(host);
  cleanup.push(() => {
    app.unmount();
    host.remove();
  });
  return host;
}
describe("Oracle security page", () => {
  it("uses OceanBase dictionary columns when restricted readers fall back", async () => {
    mocks.executeQuery.mockImplementation(async (_connection: string, _database: string, sql: string) => {
      if (/FROM DBA_/.test(sql)) throw new Error("ORA-01031");
      if (sql.includes("FROM USER_ROLE_PRIVS") && sql.includes("USERNAME AS GRANTEE")) throw new Error("ORA-00904");
      if (sql.includes("FROM ALL_COL_PRIVS") && sql.includes("TABLE_SCHEMA")) throw new Error("ORA-00904");
      if (sql.includes("FROM DUAL")) return { columns: ["USERNAME"], rows: [["Reader"]] };
      return { columns: [], rows: [] };
    });
    const host = mount("oceanbase-oracle");
    await settle();
    expect(host.querySelectorAll('[data-security-state="error"]').length).toBe(0);
    const queries = mocks.executeQuery.mock.calls.map((call) => call[2] as string);
    expect(queries.find((sql) => sql.includes("FROM USER_ROLE_PRIVS UNION"))).toContain("SELECT GRANTEE,");
    expect(queries.find((sql) => sql.includes("FROM ALL_COL_PRIVS UNION"))).toContain("SELECT GRANTEE, OWNER,");
  });

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
    const owner = host.querySelector('input[placeholder="Exact object owner"]') as HTMLInputElement;
    owner.value = "Owner";
    owner.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(host.textContent).toContain("Owner.T");
    expect(host.textContent).not.toContain("Other.T");
    expect(mocks.executeQuery.mock.calls.every((call) => /^SELECT\s/.test(call[2]))).toBe(true);
  });

  it("does not label failed dictionary reads as empty grants", async () => {
    mocks.executeQuery.mockRejectedValue(new Error("connection lost"));
    const host = mount();
    await settle();
    expect(host.querySelectorAll('[data-security-state="error"]').length).toBe(7);
    expect(host.textContent).toContain("Read failed");
    expect(host.textContent).not.toContain("Empty in visible scope");
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
});
