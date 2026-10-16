// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import FieldLineagePanel from "@/components/lineage/FieldLineagePanel.vue";
import type { FieldLineageTabState } from "@/types/database";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listTables: vi.fn().mockResolvedValue([{ name: "orders", table_type: "TABLE" }]),
  getColumns: vi.fn().mockResolvedValue([{ name: "user_id" }, { name: "amount" }]),
  listForeignKeys: vi.fn().mockResolvedValue([]),
  getTableDdl: vi.fn().mockResolvedValue("CREATE VIEW v AS SELECT 1"),
  loadHistory: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    connections: [{ id: "conn-1", name: "MySQL", db_type: "mysql", driver_profile: "mysql" }],
    getConfig: (id: string) => (id === "conn-1" ? { id, name: "MySQL", db_type: "mysql", driver_profile: "mysql" } : undefined),
    ensureConnected: mocks.ensureConnected,
  }),
}));

vi.mock("@/lib/backend/api", () => ({
  listTables: mocks.listTables,
  getColumns: mocks.getColumns,
  listForeignKeys: mocks.listForeignKeys,
  getTableDdl: mocks.getTableDdl,
  loadHistory: mocks.loadHistory,
}));

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function snapshot(column: string): FieldLineageTabState {
  return {
    config: { connectionId: "conn-1", database: "shop", schema: "public", table: "orders", column },
    sessionId: null,
  };
}

const mountedApps: App[] = [];
const emitted: Record<string, unknown[]> = {};

async function flushAsyncSetup() {
  for (let index = 0; index < 12; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function mountTabPanel(initialState: FieldLineageTabState, key = "a") {
  const container = document.createElement("div");
  container.setAttribute("data-panel", key);
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(FieldLineagePanel, {
            inDialog: false,
            initialState,
            onConvertToDialog: (state: unknown) => {
              const list = (emitted["convert-to-dialog"] ??= []);
              list.push(state);
            },
          });
      },
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.use(createPinia());
  app.mount(container);
  return app;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.textContent = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  for (const key of Object.keys(emitted)) delete emitted[key];
});

describe("FieldLineagePanel tab form factor", () => {
  it("runs the analysis for the snapshot config (conversion is owned by the tab pill)", async () => {
    installLocalStorage();
    mountTabPanel(snapshot("user_id"));
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("public.orders.user_id");
    });
    await flushAsyncSetup();

    expect([...document.querySelectorAll("button")].some((button) => button.textContent?.includes(i18n.global.t("workspace.convertToDialog")))).toBe(false);
  }, 30_000);

  it("keeps two different fields as independent panels (multi-lineage comparison)", async () => {
    installLocalStorage();
    mountTabPanel(snapshot("user_id"), "a");
    mountTabPanel(snapshot("amount"), "b");
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("public.orders.user_id");
      expect(document.body.textContent).toContain("public.orders.amount");
    });
    expect([...document.querySelectorAll("button")].some((button) => button.textContent?.includes(i18n.global.t("workspace.convertToDialog")))).toBe(false);
  }, 30_000);
});
