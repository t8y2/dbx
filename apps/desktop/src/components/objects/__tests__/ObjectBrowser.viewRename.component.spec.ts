// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/backend/api")>(),
  listObjects: vi.fn(),
  listSchemas: vi.fn().mockResolvedValue(["APP"]),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
  buildRenameObjectSql: vi.fn().mockResolvedValue('RENAME "Old View" TO "New View"'),
  getObjectSource: vi.fn().mockResolvedValue({ source: 'CREATE PROCEDURE "APP"."Old View" AS BEGIN NULL; END;', editable: true }),
  buildRoutineRenameObjectSourceStatements: vi.fn().mockResolvedValue(["preflight", "create", "validate", "grants", "drop"]),
  executeQuery: vi.fn(),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveSchemaCache: vi.fn().mockResolvedValue(undefined),
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("vue-virtual-scroller", () => ({ RecycleScroller: defineComponent({ props: ["items"], setup: (props, { slots }) => () => h("div", props.items.map((item: unknown) => slots.default?.({ item }))) }) }));
vi.mock("@/components/ui/CustomContextMenu.vue", () => ({ default: defineComponent({
  props: ["items"],
  setup(props, { slots }) {
    return () => h("div", [slots.default?.({ onContextMenu: () => undefined, isOpen: false }), ...props.items().filter((item: ContextMenuItem) => item.label === i18n.global.t("contextMenu.renameObject")).map((item: ContextMenuItem) => h("button", { "data-open-rename": true, onClick: item.action }, item.label))]);
  },
}) }));
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/ProcedureExecutionDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/CustomTypeInfoPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/export/XlsxHeaderDialog.vue", () => ({ default: { render: () => null } }));

import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";

const connection = { id: "ob-rename", name: "OB", db_type: "oceanbase-oracle" as const, database: "APP", host: "localhost", port: 2881, username: "APP", password: "", is_production: true };
const mounted: App[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  invalidateObjectBrowserRowsCache({});
  vi.mocked(api.listObjects).mockResolvedValue([{ name: "Old View", schema: "APP", object_type: "VIEW" }]);
  vi.mocked(api.executeQuery).mockResolvedValue({ columns: [], rows: [] } as any);
  vi.mocked(api.getObjectSource).mockResolvedValue({ source: 'CREATE PROCEDURE "APP"."Old View" AS BEGIN NULL; END;', editable: true } as any);
  vi.mocked(api.buildRoutineRenameObjectSourceStatements).mockResolvedValue(["preflight", "create", "validate", "grants", "drop"]);
});
afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = "";
  invalidateObjectBrowserRowsCache({});
  vi.restoreAllMocks();
});

async function openRename(objectType: "VIEW" | "PROCEDURE" | "FUNCTION" | "PACKAGE" | "PACKAGE_BODY" = "VIEW", cleanup = false) {
  vi.mocked(api.listObjects).mockResolvedValue([{ name: "Old View", schema: "APP", object_type: objectType }]);
  const pinia = createPinia();
  setActivePinia(pinia);
  const connections = useConnectionStore();
  connections.connections = [connection];
  vi.spyOn(connections, "ensureConnected").mockResolvedValue(undefined);
  const refresh = vi.spyOn(connections, "refreshObjectListTreeNode").mockResolvedValue(undefined);
  const settings = useSettingsStore();
  settings.editorSettings.objectBrowserViewMode = "list";
  const queries = useQueryStore();
  const sourceId = queries.openObjectSourceTab({ connectionId: connection.id, database: "APP", schema: "APP", title: "Old View", sql: "CREATE VIEW old_view AS SELECT 1", objectSource: { schema: "APP", name: "Old View", objectType } });
  queries.updateSql(sourceId, "CREATE VIEW old_view AS SELECT 2");
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection, database: "APP" }) });
  app.use(pinia);
  app.use(i18n);
  app.mount(container);
  mounted.push(app);
  await vi.waitFor(() => expect(container.querySelector("[data-open-rename]")).not.toBeNull());
  (container.querySelector("[data-open-rename]") as HTMLElement).click();
  await nextTick();
  const dialog = document.querySelector('[role="dialog"]')!;
  const input = dialog.querySelector("input")!;
  input.value = "New View";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  if (cleanup) {
    const checkbox = dialog.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
  }
  const button = [...dialog.querySelectorAll("button")].find((item) => item.textContent?.trim() === i18n.global.t(cleanup ? "contextMenu.packageCleanupAction" : "contextMenu.renameObject"))!;
  button.click();
  const safety = useProductionSafetyStore();
  await vi.waitFor(() => expect(safety.pending).toBeDefined());
  return { container, queries, sourceId, safety, refresh };
}

describe("ObjectBrowser OceanBase view rename", () => {
  it("does not mutate or detach source when confirmation is cancelled", async () => {
    const { queries, sourceId, safety, refresh } = await openRename();
    safety.cancel();
    await nextTick();
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(queries.tabs.find((tab) => tab.id === sourceId)?.objectSource?.name).toBe("Old View");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("keeps old source editable and reports the database error on failure", async () => {
    vi.mocked(api.executeQuery).mockRejectedValueOnce(new Error("ORA-00955: name is already used"));
    const { queries, sourceId, safety, refresh } = await openRename();
    safety.confirm();
    await vi.waitFor(() => expect(document.body.textContent).toContain("ORA-00955"));
    expect(queries.tabs.find((tab) => tab.id === sourceId)?.objectSource?.name).toBe("Old View");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes the renamed view and preserves edited source as a non-executable snapshot", async () => {
    const { container, queries, sourceId, safety, refresh } = await openRename();
    vi.mocked(api.listObjects).mockResolvedValue([{ name: "New View", schema: "APP", object_type: "VIEW" }]);
    safety.confirm();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(container.textContent).toContain("New View");
    expect(queries.tabs.find((tab) => tab.id === sourceId)).toMatchObject({ sourceSnapshot: true, sql: "CREATE VIEW old_view AS SELECT 2" });
    expect(api.executeQuery).toHaveBeenCalledWith(connection.id, "APP", expect.any(String), "APP");
  });
});

describe("ObjectBrowser OceanBase routine rename", () => {
  it("cancels the entire plan before executing any step", async () => {
    const { queries, sourceId, safety } = await openRename("PROCEDURE");
    safety.cancel();
    await nextTick();
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(queries.tabs.find((tab) => tab.id === sourceId)?.objectSource?.name).toBe("Old View");
    expect(queries.tabs.some((tab) => tab.sourceSnapshot)).toBe(false);
  });

  it.each([3, 4])("stops at step %i, refreshes the partial result and keeps original source editable", async (failedStep) => {
    vi.mocked(api.executeQuery).mockImplementation(async (_connection, _database, sql) => {
      if (sql === ["preflight", "create", "validate", "grants", "drop"][failedStep - 1]) throw new Error("routine-stage-error");
      return { columns: [], rows: [] } as any;
    });
    const { queries, sourceId, safety, refresh } = await openRename("PROCEDURE");
    safety.confirm();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(document.body.textContent).toContain("routine-stage-error");
    expect(api.executeQuery).toHaveBeenCalledTimes(failedStep);
    expect(queries.tabs.find((tab) => tab.id === sourceId)?.objectSource?.name).toBe("Old View");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("preserves text as a snapshot when the final step response is lost", async () => {
    vi.mocked(api.executeQuery).mockImplementation(async (_connection, _database, sql) => {
      if (sql === "drop") throw new Error("connection lost");
      return { columns: [], rows: [] } as any;
    });
    const { queries, sourceId, safety, refresh } = await openRename("FUNCTION");
    safety.confirm();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(document.body.textContent).toContain("connection lost");
    expect(queries.tabs.find((tab) => tab.id === sourceId)).toMatchObject({ sourceSnapshot: true, sql: "CREATE VIEW old_view AS SELECT 2" });
    expect(queries.tabs.find((tab) => tab.id === sourceId)?.objectSource).toBeUndefined();
  });

  it("runs all stages before replacing the visible identity", async () => {
    const { container, queries, sourceId, safety, refresh } = await openRename("PROCEDURE");
    vi.mocked(api.listObjects).mockResolvedValue([{ name: "New View", schema: "APP", object_type: "PROCEDURE" }]);
    vi.mocked(api.executeQuery).mockImplementation(async () => {
      expect(queries.tabs.some((tab) => tab.sourceSnapshot && tab.sql === 'CREATE PROCEDURE "APP"."Old View" AS BEGIN NULL; END;')).toBe(true);
      return { columns: [], rows: [] } as any;
    });
    safety.confirm();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(vi.mocked(api.executeQuery).mock.calls.map((call) => call[2])).toEqual(["preflight", "create", "validate", "grants", "drop"]);
    expect(container.textContent).toContain("New View");
    expect(queries.tabs.find((tab) => tab.id === sourceId)?.sourceSnapshot).toBe(true);
  });
});

describe("ObjectBrowser package migration", () => {
  function preparePackage(fail?: string) {
    vi.mocked(api.getObjectSource).mockImplementation(async (_connection, _database, schema, name, objectType) => ({
      schema, name, object_type: objectType, source: `CREATE ${objectType === "PACKAGE_BODY" ? "PACKAGE BODY" : "PACKAGE"} "APP"."${name}" AS END;`,
    }));
    vi.mocked(api.buildRoutineRenameObjectSourceStatements).mockImplementation(async (input) => input.packageCleanup ? ["cleanup", "readback"] : ["preflight", "create spec", "create body", "validate pair", "copy grants", "dependencies"]);
    vi.mocked(api.executeQuery).mockImplementation(async (_connection, _database, sql) => {
      if (sql.startsWith("SELECT OBJECT_TYPE")) return { columns: ["OBJECT_TYPE"], rows: [["PACKAGE"], ["PACKAGE BODY"]] } as any;
      if (sql === fail) throw new Error("package-stage-error");
      if (sql === "readback") return { columns: ["OLD_OBJECTS", "VALID_NEW_OBJECTS", "NEW_OBJECTS", "COMPILE_ERRORS"], rows: [[0, 2, 2, 0]] } as any;
      return { columns: [], rows: [] } as any;
    });
  }

  it("allows read-only preparation but sends no DDL when production confirmation is cancelled", async () => {
    preparePackage();
    const { safety, queries } = await openRename("PACKAGE");
    safety.cancel();
    await nextTick();
    expect(vi.mocked(api.executeQuery).mock.calls.every((call) => call[2].startsWith("SELECT"))).toBe(true);
    expect(queries.tabs.some((tab) => tab.sourceSnapshot)).toBe(false);
  });

  it("keeps the original identity and recovery snapshot after the new package is validated", async () => {
    preparePackage();
    const { safety, queries, sourceId, refresh } = await openRename("PACKAGE_BODY");
    safety.confirm();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(queries.tabs.find((tab) => tab.id === sourceId)?.objectSource?.name).toBe("Old View");
    const snapshot = queries.tabs.find((tab) => tab.sourceSnapshot);
    expect(snapshot?.sql).toContain("ORIGINAL BODY");
    expect(snapshot?.sql).toContain("6. inspect remaining dependencies: response received");
    expect(vi.mocked(api.executeQuery).mock.calls.some((call) => /DROP PACKAGE/i.test(call[2]))).toBe(false);
  });

  it("stops after pair validation fails and records the attempted step", async () => {
    preparePackage("validate pair");
    const { safety, queries, refresh } = await openRename("PACKAGE");
    safety.confirm();
    await vi.waitFor(() => expect(document.body.textContent).toContain("package-stage-error"));
    expect(vi.mocked(api.executeQuery).mock.calls.some((call) => call[2] === "copy grants")).toBe(false);
    expect(queries.tabs.find((tab) => tab.sourceSnapshot)?.sql).toContain("attempted; read back database state");
    expect(refresh).toHaveBeenCalled();
  });

  it("cancels explicit cleanup before any destructive statement", async () => {
    preparePackage();
    const { safety, queries, sourceId } = await openRename("PACKAGE", true);
    safety.cancel();
    await nextTick();
    expect(vi.mocked(api.executeQuery).mock.calls.every((call) => call[2].startsWith("SELECT"))).toBe(true);
    expect(queries.tabs.find((tab) => tab.id === sourceId)?.objectSource?.name).toBe("Old View");
    expect(queries.tabs.some((tab) => tab.sourceSnapshot)).toBe(false);
  });

  it("detaches both original sources only after cleanup is read back", async () => {
    preparePackage();
    const { safety, queries, sourceId, refresh } = await openRename("PACKAGE", true);
    const bodyId = queries.openObjectSourceTab({ connectionId: connection.id, database: "APP", schema: "APP", title: "Old View body", sql: "unsaved body", objectSource: { schema: "APP", name: "Old View", objectType: "PACKAGE_BODY" } });
    vi.mocked(api.listObjects).mockResolvedValue([{ name: "New View", schema: "APP", object_type: "PACKAGE" }]);
    safety.confirm();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    for (const id of [sourceId, bodyId]) {
      expect(queries.tabs.find((tab) => tab.id === id)?.sourceSnapshot).toBe(true);
      expect(queries.tabs.find((tab) => tab.id === id)?.objectSource).toBeUndefined();
    }
    expect(queries.tabs.find((tab) => tab.id === bodyId)?.sql).toBe("unsaved body");
    expect(vi.mocked(api.executeQuery).mock.calls.some((call) => call[2] === "readback")).toBe(true);
  });

  it("preserves original text as a snapshot when cleanup readback fails", async () => {
    preparePackage("readback");
    const { safety, queries, sourceId } = await openRename("PACKAGE", true);
    safety.confirm();
    await vi.waitFor(() => expect(document.body.textContent).toContain("package-stage-error"));
    expect(queries.tabs.find((tab) => tab.id === sourceId)).toMatchObject({ sourceSnapshot: true, sql: "CREATE VIEW old_view AS SELECT 2" });
    expect(queries.tabs.find((tab) => tab.id === sourceId)?.objectSource).toBeUndefined();
  });
});
