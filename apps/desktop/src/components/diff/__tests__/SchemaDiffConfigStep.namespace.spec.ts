// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { getDefaultOptionsForDbType } from "@/types/schemaDiff";
import SchemaDiffConfigStep from "@/components/diff/SchemaDiffConfigStep.vue";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listDatabases: vi.fn().mockResolvedValue([]),
  listSchemas: vi.fn().mockResolvedValue(["APP", "REPORTING"]),
  executeQuery: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock("@/stores/connectionStore", () => {
  const connection = { id: "oracle-11g", name: "Oracle 11g", db_type: "oracle", driver_profile: "oracle", database: "XE" };
  const connections = [connection, { id: "pg-1", name: "PostgreSQL 1", db_type: "postgres" }, { id: "pg-2", name: "PostgreSQL 2", db_type: "postgres" }];
  return {
    useConnectionStore: () => ({
      connections,
      sidebarLayout: { groups: [], order: connections.map(({ id }) => ({ type: "connection", id })) },
      getConfig: (id: string) => connections.find((item) => item.id === id),
      ensureConnected: mocks.ensureConnected,
    }),
  };
});

vi.mock("@/lib/backend/api", () => ({
  listDatabases: mocks.listDatabases,
  listSchemas: mocks.listSchemas,
  executeQuery: mocks.executeQuery,
}));

const mountedApps: App[] = [];

beforeEach(() => {
  mocks.ensureConnected.mockReset().mockResolvedValue(undefined);
  mocks.listDatabases.mockReset().mockResolvedValue([]);
  mocks.listSchemas.mockReset().mockResolvedValue(["APP", "REPORTING"]);
  mocks.executeQuery.mockReset().mockResolvedValue({ rows: [] });
});

function mountPostgresEndpoint(side: "source" | "target") {
  const endpoints = reactive({
    sourceConnectionId: "",
    sourceDatabase: "",
    sourceSchema: "",
    targetConnectionId: "",
    targetDatabase: "",
    targetSchema: "",
  });
  endpoints[`${side}ConnectionId`] = "pg-1";
  endpoints[`${side}Database`] = "app";
  endpoints[`${side}Schema`] = "public";
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(SchemaDiffConfigStep, {
          ...endpoints,
          configs: [],
          activeConfigId: "",
          ignoreComments: false,
          options: { ...getDefaultOptionsForDbType("postgres"), functions: false },
          tableListLoader: { load: vi.fn().mockResolvedValue([]) },
          loading: false,
          recentConfigs: [],
          "onUpdate:sourceSchema": (value: string) => {
            endpoints.sourceSchema = value;
          },
          "onUpdate:targetSchema": (value: string) => {
            endpoints.targetSchema = value;
          },
        }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  return { endpoints, container };
}

function selectOptions() {
  return [...document.querySelectorAll<HTMLButtonElement>(".dbx-searchable-select-list button")];
}

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

it.each(["source", "target"] as const)("keeps pending %s database choices when the user selects another schema", async (side) => {
  let resolveDatabases!: (value: Array<{ name: string }>) => void;
  mocks.listDatabases.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveDatabases = resolve;
    }),
  );
  mocks.listSchemas.mockResolvedValue(["public", "analytics"]);
  const { endpoints, container } = mountPostgresEndpoint(side);
  await flushAsyncSetup();

  const triggers = [...container.querySelectorAll<HTMLButtonElement>("button.dbx-searchable-select-trigger")];
  const database = triggers.find((button) => button.textContent?.trim() === "app")!;
  const schema = triggers.find((button) => button.textContent?.trim() === "public")!;
  expect(database.disabled).toBe(true);
  expect(schema.disabled).toBe(false);
  schema.click();
  await flushAsyncSetup();
  selectOptions()
    .find((button) => button.textContent?.trim() === "analytics")!
    .click();
  await flushAsyncSetup();
  expect(endpoints[`${side}Schema`]).toBe("analytics");

  resolveDatabases([{ name: "app" }, { name: "reporting" }]);
  await flushAsyncSetup();
  expect(database.disabled).toBe(false);
  database.click();
  await flushAsyncSetup();
  expect(selectOptions().map((button) => button.textContent?.trim())).toEqual(expect.arrayContaining(["app", "reporting"]));
});

it.each(["source", "target"] as const)("rejects stale %s database choices after switching away and back", async (side) => {
  let resolveOldDatabases!: (value: Array<{ name: string }>) => void;
  mocks.listDatabases
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOldDatabases = resolve;
      }),
    )
    .mockResolvedValue([{ name: "app" }]);
  mocks.listSchemas.mockResolvedValue(["public", "analytics"]);
  const { endpoints, container } = mountPostgresEndpoint(side);
  await flushAsyncSetup();
  endpoints[`${side}ConnectionId`] = "pg-2";
  await flushAsyncSetup();
  endpoints[`${side}ConnectionId`] = "pg-1";
  await flushAsyncSetup();

  resolveOldDatabases([{ name: "obsolete" }]);
  await flushAsyncSetup();
  const database = [...container.querySelectorAll<HTMLButtonElement>("button.dbx-searchable-select-trigger")].find((button) => button.textContent?.trim() === "app")!;
  expect(database.disabled).toBe(false);
  database.click();
  await flushAsyncSetup();
  expect(selectOptions().map((button) => button.textContent?.trim())).toEqual(["app"]);
  expect(mocks.listDatabases.mock.calls.map(([id]) => id)).toEqual(["pg-1", "pg-2", "pg-1"]);
});
