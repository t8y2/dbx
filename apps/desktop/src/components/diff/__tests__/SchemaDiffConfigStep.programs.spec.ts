// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { getDefaultOptionsForDbType, normalizeSchemaDiffCompareOptions, type OracleRoutineKind, type OracleRoutineIdentity, type SchemaDiffCompareOptions } from "@/types/schemaDiff";
import SchemaDiffConfigStep from "@/components/diff/SchemaDiffConfigStep.vue";

const backend = vi.hoisted(() => ({ listObjects: vi.fn(), loadSchemaDiffRoutines: vi.fn() }));
vi.mock("@/stores/connectionStore", () => {
  const connections = [
    { id: "source", name: "Source", db_type: "oceanbase-oracle" },
    { id: "target", name: "Target", db_type: "oceanbase-oracle" },
    { id: "mysql", name: "MySQL", db_type: "mysql" },
  ];
  return { useConnectionStore: () => ({ connections, sidebarLayout: { groups: [], order: [] }, getConfig: (id: string) => connections.find((connection) => connection.id === id), ensureConnected: vi.fn().mockResolvedValue(undefined) }) };
});
vi.mock("@/lib/backend/api", () => ({ ...backend, listDatabases: vi.fn().mockResolvedValue(["S", "T"]), listSchemas: vi.fn().mockResolvedValue(["S", "T"]), executeQuery: vi.fn().mockResolvedValue({ rows: [] }) }));

const name = 'Pkg.With.Dot,"中文😀';
const rows = (kinds: string[]) => kinds.map((object_type) => ({ name: object_type.startsWith("PACKAGE") ? name : object_type === "FUNCTION" ? "F" : "P", object_type }));
const apps: App[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  backend.listObjects.mockImplementation(async (_id, _db, _schema, kinds: string[]) => rows(kinds));
});
afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
  document.body.textContent = "";
});
async function flush() {
  for (let index = 0; index < 8; index++) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
function mountConfig(options: Partial<SchemaDiffCompareOptions> = {}, targetConnectionId = "target") {
  const state = reactive({ options: { ...getDefaultOptionsForDbType("oceanbase-oracle"), tables: false, views: false, functions: true, ...options } });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp({
    setup: () => () =>
      h(SchemaDiffConfigStep, {
        sourceConnectionId: "source",
        sourceDatabase: "S",
        sourceSchema: "S",
        targetConnectionId,
        targetDatabase: "T",
        targetSchema: "T",
        configs: [],
        activeConfigId: "",
        ignoreComments: false,
        options: state.options,
        selectedRoutines: state.options.selectedRoutines,
        loading: false,
        recentConfigs: [],
        tableListLoader: { load: vi.fn().mockResolvedValue([]) },
        "onUpdate:routineSelection": (selection: { objectKinds: OracleRoutineKind[]; selectedObjects?: Pick<OracleRoutineIdentity, "name" | "kind">[] }) => {
          state.options = normalizeSchemaDiffCompareOptions({ ...state.options, routineObjectKinds: selection.objectKinds, selectedRoutineObjects: selection.selectedObjects, selectedRoutines: undefined, routineMappings: [] });
        },
        "onUpdate:selectedRoutines": (selectedRoutines?: string[]) => {
          state.options = { ...state.options, selectedRoutines };
        },
        "onUpdate:compareScope": (scope: { functions?: boolean }) => {
          state.options = { ...state.options, ...scope };
        },
      }),
  });
  apps.push(app);
  app.use(i18n);
  app.mount(container);
  return { state, container };
}

it("keeps the legacy listing request unchanged and lets BODY-only selection use an opaque kind key with a readable label", async () => {
  const { state, container } = mountConfig();
  await flush();
  expect(backend.listObjects).toHaveBeenCalledWith("source", "S", "S", ["PROCEDURE", "FUNCTION"]);
  expect(state.options.routineObjectKinds).toBeUndefined();
  container.querySelector<HTMLInputElement>('[data-program-kind="PACKAGE_BODY"]')!.click();
  await flush();
  expect(state.options.routineObjectKinds).toEqual(["PROCEDURE", "FUNCTION", "PACKAGE_BODY"]);
  [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === i18n.global.t("diff.chooseRoutines"))!.click();
  await flush();
  const key = JSON.stringify(["PACKAGE_BODY", name, ""]);
  const body = [...container.querySelectorAll<HTMLButtonElement>("[data-table-name]")].find((button) => button.dataset.tableName === key)!;
  expect(body.textContent).toContain(`PACKAGE BODY ${name}`);
  expect(body.textContent).not.toContain('["PACKAGE_BODY"');
  body.click();
  await flush();
  expect(state.options.selectedRoutineObjects).toEqual([{ name, kind: "PACKAGE_BODY" }]);
  expect(state.options.selectedRoutines).toBeUndefined();
  container.querySelector<HTMLInputElement>('[data-program-kind="PACKAGE"]')!.click();
  await flush();
  expect(state.options.selectedRoutineObjects).toEqual([{ name, kind: "PACKAGE_BODY" }]);
  [...container.querySelectorAll<HTMLButtonElement>("[data-table-name]")].find((button) => button.dataset.tableName === JSON.stringify(["PACKAGE", name, ""]))!.click();
  await flush();
  expect(state.options.selectedRoutineObjects).toEqual([
    { name, kind: "PACKAGE_BODY" },
    { name, kind: "PACKAGE" },
  ]);
  expect(backend.loadSchemaDiffRoutines).not.toHaveBeenCalled();
});

it("does not let an older kind-list response remove a newer restored package selection", async () => {
  const { state, container } = mountConfig();
  await flush();
  let resolveOld!: (value: ReturnType<typeof rows>) => void;
  backend.listObjects.mockImplementation(async (_id, _db, _schema, kinds: string[]) =>
    kinds.includes("PACKAGE_BODY")
      ? new Promise((resolve) => {
          resolveOld = resolve;
        })
      : rows(kinds),
  );
  container.querySelector<HTMLInputElement>('[data-program-kind="PACKAGE_BODY"]')!.click();
  await vi.waitFor(() => expect(resolveOld).toBeTypeOf("function"));
  state.options = normalizeSchemaDiffCompareOptions({ ...state.options, routineObjectKinds: ["PACKAGE"], selectedRoutineObjects: [{ name, kind: "PACKAGE" }], selectedRoutines: undefined });
  await flush();
  resolveOld(rows(["PACKAGE_BODY"]));
  await flush();
  expect(state.options.selectedRoutineObjects).toEqual([{ name, kind: "PACKAGE" }]);
  expect([...container.querySelectorAll<HTMLButtonElement>("[data-table-name]")].map((button) => button.dataset.tableName)).toContain(JSON.stringify(["PACKAGE", name, ""]));
  expect(container.querySelector<HTMLInputElement>('[data-program-kind="PACKAGE_BODY"]')!.checked).toBe(false);
});

it("retains an explicit legacy function selection when package kinds are enabled", async () => {
  const { state, container } = mountConfig({ selectedRoutines: ["F"] });
  await flush();
  container.querySelector<HTMLInputElement>('[data-program-kind="PACKAGE"]')!.click();
  await flush();
  expect(state.options.selectedRoutineObjects).toEqual([{ name: "F", kind: "FUNCTION" }]);
  expect(state.options.selectedRoutines).toBeUndefined();
});

it("lets an unsupported restored package scope be turned off explicitly without silently filtering it", async () => {
  const { state, container } = mountConfig({ tables: true, routineObjectKinds: ["PACKAGE"] }, "mysql");
  await flush();
  const toggle = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((button) => button.getAttribute("aria-label") === i18n.global.t("diff.compareRoutinesSwitch"))!;
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(toggle.disabled).toBe(false);
  toggle.click();
  await flush();
  expect(state.options.functions).toBe(false);
  expect(state.options.routineObjectKinds).toEqual(["PACKAGE"]);
  expect(backend.loadSchemaDiffRoutines).not.toHaveBeenCalled();
});
