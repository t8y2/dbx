// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DataCompareDialog from "@/components/diff/DataCompareDialog.vue";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listDatabases: vi.fn().mockResolvedValue([{ name: "DBX_TEST" }, { name: "OPS$ORACLE" }]),
  listSchemas: vi.fn().mockResolvedValue(["DBX_TEST"]),
  listTables: vi.fn().mockResolvedValue([{ name: "CODEX_7046_META", table_type: "TABLE" }]),
  getColumns: vi.fn().mockResolvedValue([{ name: "ID", data_type: "NUMBER", is_primary_key: true }]),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    connections: [{ id: "oracle-11g", name: "Oracle XE 11g", db_type: "oracle", driver_profile: "oracle", database: "XE" }],
    getConfig: (id: string) => (id === "oracle-11g" ? { id, name: "Oracle XE 11g", db_type: "oracle", driver_profile: "oracle", database: "XE" } : undefined),
    ensureConnected: mocks.ensureConnected,
  }),
}));

vi.mock("@/lib/backend/api", () => ({
  listDatabases: mocks.listDatabases,
  listSchemas: mocks.listSchemas,
  listTables: mocks.listTables,
  getColumns: mocks.getColumns,
}));

const mountedApps: App[] = [];

async function flushAsyncSetup() {
  for (let index = 0; index < 8; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("DataCompareDialog source prefill", () => {
  it("keeps the Oracle source table after loading database and schema prefills", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(
      defineComponent({
        setup: () => () =>
          h(DataCompareDialog, {
            open: true,
            prefillConnectionId: "oracle-11g",
            prefillDatabase: "DBX_TEST",
            prefillSchema: "DBX_TEST",
            prefillTable: "CODEX_7046_META",
          }),
      }),
    );
    mountedApps.push(app);
    app.use(i18n);
    app.mount(container);
    await flushAsyncSetup();

    expect(mocks.listTables).toHaveBeenCalledWith("oracle-11g", "DBX_TEST", "DBX_TEST");
    expect(document.body.textContent).toContain("CODEX_7046_META");
    expect(document.body.textContent).not.toContain("暂无可比较的表");
  });
});
