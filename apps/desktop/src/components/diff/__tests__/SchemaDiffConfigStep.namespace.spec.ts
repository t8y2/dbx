// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { getDefaultOptionsForDbType } from "@/types/schemaDiff";
import SchemaDiffConfigStep from "@/components/diff/SchemaDiffConfigStep.vue";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listDatabases: vi.fn().mockResolvedValue([]),
  listSchemas: vi.fn().mockResolvedValue(["APP", "REPORTING"]),
}));

vi.mock("@/stores/connectionStore", () => {
  const connection = { id: "oracle-11g", name: "Oracle 11g", db_type: "oracle", driver_profile: "oracle", database: "XE" };
  return {
    useConnectionStore: () => ({
      connections: [connection],
      sidebarLayout: { groups: [], order: [{ type: "connection", id: connection.id }] },
      getConfig: (id: string) => (id === connection.id ? connection : undefined),
      ensureConnected: mocks.ensureConnected,
    }),
  };
});

vi.mock("@/lib/backend/api", () => ({
  listDatabases: mocks.listDatabases,
  listSchemas: mocks.listSchemas,
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
  document.body.textContent = "";
  vi.clearAllMocks();
});

it("offers Oracle schemas as schema-diff database choices", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(SchemaDiffConfigStep, {
          configs: [],
          activeConfigId: "",
          sourceConnectionId: "oracle-11g",
          sourceDatabase: "",
          sourceSchema: "",
          targetConnectionId: "",
          targetDatabase: "",
          targetSchema: "",
          ignoreComments: false,
          options: getDefaultOptionsForDbType("oracle"),
          tableListLoader: { load: vi.fn().mockResolvedValue([]) },
          loading: false,
          recentConfigs: [],
        }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await flushAsyncSetup();

  const sourceDatabase = document.querySelector<HTMLButtonElement>("button.dbx-searchable-select-trigger");
  expect(sourceDatabase?.disabled).toBe(false);
  sourceDatabase?.click();
  await flushAsyncSetup();

  const options = [...document.querySelectorAll<HTMLButtonElement>(".dbx-searchable-select-list button")].map((button) => button.textContent?.trim());
  expect(options).toEqual(expect.arrayContaining(["APP", "REPORTING"]));
  expect(mocks.listDatabases).not.toHaveBeenCalled();
  expect(mocks.listSchemas).toHaveBeenCalledWith("oracle-11g", "XE", true);
});
